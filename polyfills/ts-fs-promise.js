import fs$2 from 'fs';
import constants from 'constants';
import stream from 'stream';
import util from 'util';
import assert from 'assert';
import 'module';
import vm from 'vm';
import buffer from 'buffer';
import v8 from 'v8';
import path$1 from 'path';
import events from 'events';

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function commonjsRequire () {
	throw new Error('Dynamic requires are not currently supported by rollup-plugin-commonjs');
}

function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var origCwd = process.cwd;
var cwd = null;

var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;

process.cwd = function() {
  if (!cwd)
    cwd = origCwd.call(process);
  return cwd
};
try {
  process.cwd();
} catch (er) {}

var chdir = process.chdir;
process.chdir = function(d) {
  cwd = null;
  chdir.call(process, d);
};

var polyfills = patch;

function patch (fs) {
  // (re-)implement some things that are known busted or missing.

  // lchmod, broken prior to 0.6.2
  // back-port the fix here.
  if (constants.hasOwnProperty('O_SYMLINK') &&
      process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
    patchLchmod(fs);
  }

  // lutimes implementation, or no-op
  if (!fs.lutimes) {
    patchLutimes(fs);
  }

  // https://github.com/isaacs/node-graceful-fs/issues/4
  // Chown should not fail on einval or eperm if non-root.
  // It should not fail on enosys ever, as this just indicates
  // that a fs doesn't support the intended operation.

  fs.chown = chownFix(fs.chown);
  fs.fchown = chownFix(fs.fchown);
  fs.lchown = chownFix(fs.lchown);

  fs.chmod = chmodFix(fs.chmod);
  fs.fchmod = chmodFix(fs.fchmod);
  fs.lchmod = chmodFix(fs.lchmod);

  fs.chownSync = chownFixSync(fs.chownSync);
  fs.fchownSync = chownFixSync(fs.fchownSync);
  fs.lchownSync = chownFixSync(fs.lchownSync);

  fs.chmodSync = chmodFixSync(fs.chmodSync);
  fs.fchmodSync = chmodFixSync(fs.fchmodSync);
  fs.lchmodSync = chmodFixSync(fs.lchmodSync);

  fs.stat = statFix(fs.stat);
  fs.fstat = statFix(fs.fstat);
  fs.lstat = statFix(fs.lstat);

  fs.statSync = statFixSync(fs.statSync);
  fs.fstatSync = statFixSync(fs.fstatSync);
  fs.lstatSync = statFixSync(fs.lstatSync);

  // if lchmod/lchown do not exist, then make them no-ops
  if (!fs.lchmod) {
    fs.lchmod = function (path, mode, cb) {
      if (cb) process.nextTick(cb);
    };
    fs.lchmodSync = function () {};
  }
  if (!fs.lchown) {
    fs.lchown = function (path, uid, gid, cb) {
      if (cb) process.nextTick(cb);
    };
    fs.lchownSync = function () {};
  }

  // on Windows, A/V software can lock the directory, causing this
  // to fail with an EACCES or EPERM if the directory contains newly
  // created files.  Try again on failure, for up to 60 seconds.

  // Set the timeout this long because some Windows Anti-Virus, such as Parity
  // bit9, may lock files for up to a minute, causing npm package install
  // failures. Also, take care to yield the scheduler. Windows scheduling gives
  // CPU to a busy looping process, which can cause the program causing the lock
  // contention to be starved of CPU by node, so the contention doesn't resolve.
  if (platform === "win32") {
    fs.rename = (function (fs$rename) { return function (from, to, cb) {
      var start = Date.now();
      var backoff = 0;
      fs$rename(from, to, function CB (er) {
        if (er
            && (er.code === "EACCES" || er.code === "EPERM")
            && Date.now() - start < 60000) {
          setTimeout(function() {
            fs.stat(to, function (stater, st) {
              if (stater && stater.code === "ENOENT")
                fs$rename(from, to, CB);
              else
                cb(er);
            });
          }, backoff);
          if (backoff < 100)
            backoff += 10;
          return;
        }
        if (cb) cb(er);
      });
    }})(fs.rename);
  }

  // if read() returns EAGAIN, then just try it again.
  fs.read = (function (fs$read) { return function (fd, buffer, offset, length, position, callback_) {
    var callback;
    if (callback_ && typeof callback_ === 'function') {
      var eagCounter = 0;
      callback = function (er, _, __) {
        if (er && er.code === 'EAGAIN' && eagCounter < 10) {
          eagCounter ++;
          return fs$read.call(fs, fd, buffer, offset, length, position, callback)
        }
        callback_.apply(this, arguments);
      };
    }
    return fs$read.call(fs, fd, buffer, offset, length, position, callback)
  }})(fs.read);

  fs.readSync = (function (fs$readSync) { return function (fd, buffer, offset, length, position) {
    var eagCounter = 0;
    while (true) {
      try {
        return fs$readSync.call(fs, fd, buffer, offset, length, position)
      } catch (er) {
        if (er.code === 'EAGAIN' && eagCounter < 10) {
          eagCounter ++;
          continue
        }
        throw er
      }
    }
  }})(fs.readSync);

  function patchLchmod (fs) {
    fs.lchmod = function (path, mode, callback) {
      fs.open( path
             , constants.O_WRONLY | constants.O_SYMLINK
             , mode
             , function (err, fd) {
        if (err) {
          if (callback) callback(err);
          return
        }
        // prefer to return the chmod error, if one occurs,
        // but still try to close, and report closing errors if they occur.
        fs.fchmod(fd, mode, function (err) {
          fs.close(fd, function(err2) {
            if (callback) callback(err || err2);
          });
        });
      });
    };

    fs.lchmodSync = function (path, mode) {
      var fd = fs.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);

      // prefer to return the chmod error, if one occurs,
      // but still try to close, and report closing errors if they occur.
      var threw = true;
      var ret;
      try {
        ret = fs.fchmodSync(fd, mode);
        threw = false;
      } finally {
        if (threw) {
          try {
            fs.closeSync(fd);
          } catch (er) {}
        } else {
          fs.closeSync(fd);
        }
      }
      return ret
    };
  }

  function patchLutimes (fs) {
    if (constants.hasOwnProperty("O_SYMLINK")) {
      fs.lutimes = function (path, at, mt, cb) {
        fs.open(path, constants.O_SYMLINK, function (er, fd) {
          if (er) {
            if (cb) cb(er);
            return
          }
          fs.futimes(fd, at, mt, function (er) {
            fs.close(fd, function (er2) {
              if (cb) cb(er || er2);
            });
          });
        });
      };

      fs.lutimesSync = function (path, at, mt) {
        var fd = fs.openSync(path, constants.O_SYMLINK);
        var ret;
        var threw = true;
        try {
          ret = fs.futimesSync(fd, at, mt);
          threw = false;
        } finally {
          if (threw) {
            try {
              fs.closeSync(fd);
            } catch (er) {}
          } else {
            fs.closeSync(fd);
          }
        }
        return ret
      };

    } else {
      fs.lutimes = function (_a, _b, _c, cb) { if (cb) process.nextTick(cb); };
      fs.lutimesSync = function () {};
    }
  }

  function chmodFix (orig) {
    if (!orig) return orig
    return function (target, mode, cb) {
      return orig.call(fs, target, mode, function (er) {
        if (chownErOk(er)) er = null;
        if (cb) cb.apply(this, arguments);
      })
    }
  }

  function chmodFixSync (orig) {
    if (!orig) return orig
    return function (target, mode) {
      try {
        return orig.call(fs, target, mode)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }


  function chownFix (orig) {
    if (!orig) return orig
    return function (target, uid, gid, cb) {
      return orig.call(fs, target, uid, gid, function (er) {
        if (chownErOk(er)) er = null;
        if (cb) cb.apply(this, arguments);
      })
    }
  }

  function chownFixSync (orig) {
    if (!orig) return orig
    return function (target, uid, gid) {
      try {
        return orig.call(fs, target, uid, gid)
      } catch (er) {
        if (!chownErOk(er)) throw er
      }
    }
  }


  function statFix (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target, cb) {
      return orig.call(fs, target, function (er, stats) {
        if (!stats) return cb.apply(this, arguments)
        if (stats.uid < 0) stats.uid += 0x100000000;
        if (stats.gid < 0) stats.gid += 0x100000000;
        if (cb) cb.apply(this, arguments);
      })
    }
  }

  function statFixSync (orig) {
    if (!orig) return orig
    // Older versions of Node erroneously returned signed integers for
    // uid + gid.
    return function (target) {
      var stats = orig.call(fs, target);
      if (stats.uid < 0) stats.uid += 0x100000000;
      if (stats.gid < 0) stats.gid += 0x100000000;
      return stats;
    }
  }

  // ENOSYS means that the fs doesn't support the op. Just ignore
  // that, because it doesn't matter.
  //
  // if there's no getuid, or if getuid() is something other
  // than 0, and the error is EINVAL or EPERM, then just ignore
  // it.
  //
  // This specific case is a silent failure in cp, install, tar,
  // and most other unix tools that manage permissions.
  //
  // When running as root, or if other types of errors are
  // encountered, then it's strict.
  function chownErOk (er) {
    if (!er)
      return true

    if (er.code === "ENOSYS")
      return true

    var nonroot = !process.getuid || process.getuid() !== 0;
    if (nonroot) {
      if (er.code === "EINVAL" || er.code === "EPERM")
        return true
    }

    return false
  }
}

var Stream = stream.Stream;

var legacyStreams = legacy;

function legacy (fs) {
  return {
    ReadStream: ReadStream,
    WriteStream: WriteStream
  }

  function ReadStream (path, options) {
    if (!(this instanceof ReadStream)) return new ReadStream(path, options);

    Stream.call(this);

    var self = this;

    this.path = path;
    this.fd = null;
    this.readable = true;
    this.paused = false;

    this.flags = 'r';
    this.mode = 438; /*=0666*/
    this.bufferSize = 64 * 1024;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.encoding) this.setEncoding(this.encoding);

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.end === undefined) {
        this.end = Infinity;
      } else if ('number' !== typeof this.end) {
        throw TypeError('end must be a Number');
      }

      if (this.start > this.end) {
        throw new Error('start must be <= end');
      }

      this.pos = this.start;
    }

    if (this.fd !== null) {
      process.nextTick(function() {
        self._read();
      });
      return;
    }

    fs.open(this.path, this.flags, this.mode, function (err, fd) {
      if (err) {
        self.emit('error', err);
        self.readable = false;
        return;
      }

      self.fd = fd;
      self.emit('open', fd);
      self._read();
    });
  }

  function WriteStream (path, options) {
    if (!(this instanceof WriteStream)) return new WriteStream(path, options);

    Stream.call(this);

    this.path = path;
    this.fd = null;
    this.writable = true;

    this.flags = 'w';
    this.encoding = 'binary';
    this.mode = 438; /*=0666*/
    this.bytesWritten = 0;

    options = options || {};

    // Mixin options into this
    var keys = Object.keys(options);
    for (var index = 0, length = keys.length; index < length; index++) {
      var key = keys[index];
      this[key] = options[key];
    }

    if (this.start !== undefined) {
      if ('number' !== typeof this.start) {
        throw TypeError('start must be a Number');
      }
      if (this.start < 0) {
        throw new Error('start must be >= zero');
      }

      this.pos = this.start;
    }

    this.busy = false;
    this._queue = [];

    if (this.fd === null) {
      this._open = fs.open;
      this._queue.push([this._open, this.path, this.flags, this.mode, undefined]);
      this.flush();
    }
  }
}

var clone_1 = clone;

function clone (obj) {
  if (obj === null || typeof obj !== 'object')
    return obj

  if (obj instanceof Object)
    var copy = { __proto__: obj.__proto__ };
  else
    var copy = Object.create(null);

  Object.getOwnPropertyNames(obj).forEach(function (key) {
    Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
  });

  return copy
}

var gracefulFs = createCommonjsModule(function (module) {
var queue = [];



function noop () {}

var debug = noop;
if (util.debuglog)
  debug = util.debuglog('gfs4');
else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ''))
  debug = function() {
    var m = util.format.apply(util, arguments);
    m = 'GFS4: ' + m.split(/\n/).join('\nGFS4: ');
    console.error(m);
  };

if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || '')) {
  process.on('exit', function() {
    debug(queue);
    assert.equal(queue.length, 0);
  });
}

module.exports = patch(clone_1(fs$2));
if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs$2.__patched) {
    module.exports = patch(fs$2);
    fs$2.__patched = true;
}

// Always patch fs.close/closeSync, because we want to
// retry() whenever a close happens *anywhere* in the program.
// This is essential when multiple graceful-fs instances are
// in play at the same time.
module.exports.close = (function (fs$close) { return function (fd, cb) {
  return fs$close.call(fs$2, fd, function (err) {
    if (!err)
      retry();

    if (typeof cb === 'function')
      cb.apply(this, arguments);
  })
}})(fs$2.close);

module.exports.closeSync = (function (fs$closeSync) { return function (fd) {
  // Note that graceful-fs also retries when fs.closeSync() fails.
  // Looks like a bug to me, although it's probably a harmless one.
  var rval = fs$closeSync.apply(fs$2, arguments);
  retry();
  return rval
}})(fs$2.closeSync);

// Only patch fs once, otherwise we'll run into a memory leak if
// graceful-fs is loaded multiple times, such as in test environments that
// reset the loaded modules between tests.
// We look for the string `graceful-fs` from the comment above. This
// way we are not adding any extra properties and it will detect if older
// versions of graceful-fs are installed.
if (!/\bgraceful-fs\b/.test(fs$2.closeSync.toString())) {
  fs$2.closeSync = module.exports.closeSync;
  fs$2.close = module.exports.close;
}

function patch (fs) {
  // Everything that references the open() function needs to be in here
  polyfills(fs);
  fs.gracefulify = patch;
  fs.FileReadStream = ReadStream;  // Legacy name.
  fs.FileWriteStream = WriteStream;  // Legacy name.
  fs.createReadStream = createReadStream;
  fs.createWriteStream = createWriteStream;
  var fs$readFile = fs.readFile;
  fs.readFile = readFile;
  function readFile (path, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null;

    return go$readFile(path, options, cb)

    function go$readFile (path, options, cb) {
      return fs$readFile(path, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$readFile, [path, options, cb]]);
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments);
          retry();
        }
      })
    }
  }

  var fs$writeFile = fs.writeFile;
  fs.writeFile = writeFile;
  function writeFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null;

    return go$writeFile(path, data, options, cb)

    function go$writeFile (path, data, options, cb) {
      return fs$writeFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$writeFile, [path, data, options, cb]]);
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments);
          retry();
        }
      })
    }
  }

  var fs$appendFile = fs.appendFile;
  if (fs$appendFile)
    fs.appendFile = appendFile;
  function appendFile (path, data, options, cb) {
    if (typeof options === 'function')
      cb = options, options = null;

    return go$appendFile(path, data, options, cb)

    function go$appendFile (path, data, options, cb) {
      return fs$appendFile(path, data, options, function (err) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$appendFile, [path, data, options, cb]]);
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments);
          retry();
        }
      })
    }
  }

  var fs$readdir = fs.readdir;
  fs.readdir = readdir;
  function readdir (path, options, cb) {
    var args = [path];
    if (typeof options !== 'function') {
      args.push(options);
    } else {
      cb = options;
    }
    args.push(go$readdir$cb);

    return go$readdir(args)

    function go$readdir$cb (err, files) {
      if (files && files.sort)
        files.sort();

      if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
        enqueue([go$readdir, [args]]);

      else {
        if (typeof cb === 'function')
          cb.apply(this, arguments);
        retry();
      }
    }
  }

  function go$readdir (args) {
    return fs$readdir.apply(fs, args)
  }

  if (process.version.substr(0, 4) === 'v0.8') {
    var legStreams = legacyStreams(fs);
    ReadStream = legStreams.ReadStream;
    WriteStream = legStreams.WriteStream;
  }

  var fs$ReadStream = fs.ReadStream;
  if (fs$ReadStream) {
    ReadStream.prototype = Object.create(fs$ReadStream.prototype);
    ReadStream.prototype.open = ReadStream$open;
  }

  var fs$WriteStream = fs.WriteStream;
  if (fs$WriteStream) {
    WriteStream.prototype = Object.create(fs$WriteStream.prototype);
    WriteStream.prototype.open = WriteStream$open;
  }

  fs.ReadStream = ReadStream;
  fs.WriteStream = WriteStream;

  function ReadStream (path, options) {
    if (this instanceof ReadStream)
      return fs$ReadStream.apply(this, arguments), this
    else
      return ReadStream.apply(Object.create(ReadStream.prototype), arguments)
  }

  function ReadStream$open () {
    var that = this;
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        if (that.autoClose)
          that.destroy();

        that.emit('error', err);
      } else {
        that.fd = fd;
        that.emit('open', fd);
        that.read();
      }
    });
  }

  function WriteStream (path, options) {
    if (this instanceof WriteStream)
      return fs$WriteStream.apply(this, arguments), this
    else
      return WriteStream.apply(Object.create(WriteStream.prototype), arguments)
  }

  function WriteStream$open () {
    var that = this;
    open(that.path, that.flags, that.mode, function (err, fd) {
      if (err) {
        that.destroy();
        that.emit('error', err);
      } else {
        that.fd = fd;
        that.emit('open', fd);
      }
    });
  }

  function createReadStream (path, options) {
    return new ReadStream(path, options)
  }

  function createWriteStream (path, options) {
    return new WriteStream(path, options)
  }

  var fs$open = fs.open;
  fs.open = open;
  function open (path, flags, mode, cb) {
    if (typeof mode === 'function')
      cb = mode, mode = null;

    return go$open(path, flags, mode, cb)

    function go$open (path, flags, mode, cb) {
      return fs$open(path, flags, mode, function (err, fd) {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE'))
          enqueue([go$open, [path, flags, mode, cb]]);
        else {
          if (typeof cb === 'function')
            cb.apply(this, arguments);
          retry();
        }
      })
    }
  }

  return fs
}

function enqueue (elem) {
  debug('ENQUEUE', elem[0].name, elem[1]);
  queue.push(elem);
}

function retry () {
  var elem = queue.shift();
  if (elem) {
    debug('RETRY', elem[0].name, elem[1]);
    elem[0].apply(null, elem[1]);
  }
}
});
var gracefulFs_1 = gracefulFs.close;
var gracefulFs_2 = gracefulFs.closeSync;

var _fs;
try {
  _fs = gracefulFs;
} catch (_) {
  _fs = fs$2;
}

function readFile (file, options, callback) {
  if (callback == null) {
    callback = options;
    options = {};
  }

  if (typeof options === 'string') {
    options = {encoding: options};
  }

  options = options || {};
  var fs = options.fs || _fs;

  var shouldThrow = true;
  // DO NOT USE 'passParsingErrors' THE NAME WILL CHANGE!!!, use 'throws' instead
  if ('passParsingErrors' in options) {
    shouldThrow = options.passParsingErrors;
  } else if ('throws' in options) {
    shouldThrow = options.throws;
  }

  fs.readFile(file, options, function (err, data) {
    if (err) return callback(err)

    data = stripBom(data);

    var obj;
    try {
      obj = JSON.parse(data, options ? options.reviver : null);
    } catch (err2) {
      if (shouldThrow) {
        err2.message = file + ': ' + err2.message;
        return callback(err2)
      } else {
        return callback(null, null)
      }
    }

    callback(null, obj);
  });
}

function readFileSync (file, options) {
  options = options || {};
  if (typeof options === 'string') {
    options = {encoding: options};
  }

  var fs = options.fs || _fs;

  var shouldThrow = true;
  // DO NOT USE 'passParsingErrors' THE NAME WILL CHANGE!!!, use 'throws' instead
  if ('passParsingErrors' in options) {
    shouldThrow = options.passParsingErrors;
  } else if ('throws' in options) {
    shouldThrow = options.throws;
  }

  var content = fs.readFileSync(file, options);
  content = stripBom(content);

  try {
    return JSON.parse(content, options.reviver)
  } catch (err) {
    if (shouldThrow) {
      err.message = file + ': ' + err.message;
      throw err
    } else {
      return null
    }
  }
}

function writeFile (file, obj, options, callback) {
  if (callback == null) {
    callback = options;
    options = {};
  }
  options = options || {};
  var fs = options.fs || _fs;

  var spaces = typeof options === 'object' && options !== null
    ? 'spaces' in options
    ? options.spaces : this.spaces
    : this.spaces;

  var str = '';
  try {
    str = JSON.stringify(obj, options ? options.replacer : null, spaces) + '\n';
  } catch (err) {
    if (callback) return callback(err, null)
  }

  fs.writeFile(file, str, options, callback);
}

function writeFileSync (file, obj, options) {
  options = options || {};
  var fs = options.fs || _fs;

  var spaces = typeof options === 'object' && options !== null
    ? 'spaces' in options
    ? options.spaces : this.spaces
    : this.spaces;

  var str = JSON.stringify(obj, options.replacer, spaces) + '\n';
  // not sure if fs.writeFileSync returns anything, but just in case
  return fs.writeFileSync(file, str, options)
}

function stripBom (content) {
  // we do this because JSON.parse would convert it to a utf8 string if encoding wasn't specified
  if (Buffer.isBuffer(content)) content = content.toString('utf8');
  content = content.replace(/^\uFEFF/, '');
  return content
}

var jsonfile = {
  spaces: null,
  readFile: readFile,
  readFileSync: readFileSync,
  writeFile: writeFile,
  writeFileSync: writeFileSync
};

var jsonfile_1 = jsonfile;

var natives = process.binding('natives');
var source = src;
var require_1 = req;


// fallback for 0.x support
var runInThisContext, ContextifyScript, Script;
/*istanbul ignore next*/
try {
  ContextifyScript = process.binding('contextify').ContextifyScript;
  /*istanbul ignore next*/
  if (process.version.split('.')[0].length > 2) {  // v10.0.0 and above
    runInThisContext = vm.runInThisContext;
  } else {
    runInThisContext = function runInThisContext(code, options) {
      var script = new ContextifyScript(code, options);
      return script.runInThisContext();
    };
  }
} catch (er) {
  Script = process.binding('evals').NodeScript;
  runInThisContext = Script.runInThisContext;
}

var wrap = [
  '(function (internalBinding) {' +
    ' return function (exports, require, module, __filename, __dirname) { ',
  '\n  };\n});'
];


// Basically the same functionality as node's (buried deep)
// NativeModule class, but without caching, or internal/ blocking,
// or a class, since that's not really necessary.  I assume that if
// you're loading something with this module, it's because you WANT
// a separate copy.  However, to preserve semantics, any require()
// calls made throughout the internal module load IS cached.
function req (id, whitelist) {
  var cache = Object.create(null);

  if (Array.isArray(whitelist)) {
    // a whitelist of things to pull from the "actual" native modules
    whitelist.forEach(function (id) {
      cache[id] = {
        loading: false,
        loaded: true,
        filename: id + '.js',
        exports: commonjsRequire()
      };
    });
  }

  return req_(id, cache)
}

function req_ (id, cache) {
  // Buffer is special, because it's a type rather than a "normal"
  // class, and many things depend on `Buffer.isBuffer` working.
  if (id === 'buffer') {
    return buffer
  }

  // native_module isn't actually a natives binding.
  // weird, right?
  if (id === 'native_module') {
    return {
      getSource: src,
      wrap: function (script) {
        return wrap[0] + script + wrap[1]
      },
      wrapper: wrap,
      _cache: cache,
      _source: natives,
      nonInternalExists: function (id) {
        return id.indexOf('internal/') !== 0;
      }
    }
  }

  var source = src(id);
  if (!source) {
    return undefined
  }
  source = wrap[0] + source + wrap[1];

  var internalBinding = function(name) {
    if (name === 'types') {
      return process.binding('util');
    } else {
      try {
        return process.binding(name);
      } catch (e) {}
      return {};
    }
  };

  var cachingRequire = function require (id) {
    if (cache[id]) {
      return cache[id].exports
    }
    if (id === 'internal/bootstrap/loaders' || id === 'internal/process') {
      // Provide just enough to keep `graceful-fs@3` working and tests passing.
      // For now.
      return {
        internalBinding: internalBinding,
        NativeModule: {
          _source: process.binding('natives'),
          nonInternalExists: function(id) {
            return !id.startsWith('internal/');
          }
        }
      };
    }
    return req_(id, cache)
  };

  var nm = {
    exports: {},
    loading: true,
    loaded: false,
    filename: id + '.js'
  };
  cache[id] = nm;
  var fn;
  var setV8Flags = false;
  try {
    v8.setFlagsFromString('--allow_natives_syntax');
    setV8Flags = true;
  } catch (e) {}
  try {
    /* istanbul ignore else */
    if (ContextifyScript) {
      fn = runInThisContext(source, {
        filename: nm.filename,
        lineOffset: 0,
        displayErrors: true
      });
    } else {
      fn = runInThisContext(source, nm.filename, true);
    }
    fn(internalBinding)(nm.exports, cachingRequire, nm, nm.filename, '<no dirname available>');
    nm.loaded = true;
  } finally {
    nm.loading = false;
    /*istanbul ignore next*/
    if (setV8Flags) {
      // Ref: https://github.com/nodejs/node/blob/591a24b819d53a555463b1cbf9290a6d8bcc1bcb/lib/internal/bootstrap_node.js#L429-L434
      var re = /^--allow[-_]natives[-_]syntax$/;
      if (!process.execArgv.some(function (s) { return re.test(s) }))
        v8.setFlagsFromString('--noallow_natives_syntax');
    }
  }

  return nm.exports
}

function src (id) {
  return natives[id]
}

var natives_1 = {
	source: source,
	require: require_1
};

var fs = natives_1.require('fs', ['stream']);

var origCwd$1 = process.cwd;
var cwd$1 = null;
process.cwd = function() {
  if (!cwd$1)
    cwd$1 = origCwd$1.call(process);
  return cwd$1
};
var chdir$1 = process.chdir;
process.chdir = function(d) {
  cwd$1 = null;
  chdir$1.call(process, d);
};

// (re-)implement some things that are known busted or missing.

// lchmod, broken prior to 0.6.2
// back-port the fix here.
if (constants.hasOwnProperty('O_SYMLINK') &&
    process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
  fs.lchmod = function (path, mode, callback) {
    callback = callback || noop;
    fs.open( path
           , constants.O_WRONLY | constants.O_SYMLINK
           , mode
           , function (err, fd) {
      if (err) {
        callback(err);
        return
      }
      // prefer to return the chmod error, if one occurs,
      // but still try to close, and report closing errors if they occur.
      fs.fchmod(fd, mode, function (err) {
        fs.close(fd, function(err2) {
          callback(err || err2);
        });
      });
    });
  };

  fs.lchmodSync = function (path, mode) {
    var fd = fs.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);

    // prefer to return the chmod error, if one occurs,
    // but still try to close, and report closing errors if they occur.
    var err, err2;
    try {
      var ret = fs.fchmodSync(fd, mode);
    } catch (er) {
      err = er;
    }
    try {
      fs.closeSync(fd);
    } catch (er) {
      err2 = er;
    }
    if (err || err2) throw (err || err2)
    return ret
  };
}


// lutimes implementation, or no-op
if (!fs.lutimes) {
  if (constants.hasOwnProperty("O_SYMLINK")) {
    fs.lutimes = function (path, at, mt, cb) {
      fs.open(path, constants.O_SYMLINK, function (er, fd) {
        cb = cb || noop;
        if (er) return cb(er)
        fs.futimes(fd, at, mt, function (er) {
          fs.close(fd, function (er2) {
            return cb(er || er2)
          });
        });
      });
    };

    fs.lutimesSync = function (path, at, mt) {
      var fd = fs.openSync(path, constants.O_SYMLINK)
        , err
        , err2
        , ret;

      try {
        var ret = fs.futimesSync(fd, at, mt);
      } catch (er) {
        err = er;
      }
      try {
        fs.closeSync(fd);
      } catch (er) {
        err2 = er;
      }
      if (err || err2) throw (err || err2)
      return ret
    };

  } else if (fs.utimensat && constants.hasOwnProperty("AT_SYMLINK_NOFOLLOW")) {
    // maybe utimensat will be bound soonish?
    fs.lutimes = function (path, at, mt, cb) {
      fs.utimensat(path, at, mt, constants.AT_SYMLINK_NOFOLLOW, cb);
    };

    fs.lutimesSync = function (path, at, mt) {
      return fs.utimensatSync(path, at, mt, constants.AT_SYMLINK_NOFOLLOW)
    };

  } else {
    fs.lutimes = function (_a, _b, _c, cb) { process.nextTick(cb); };
    fs.lutimesSync = function () {};
  }
}


// https://github.com/isaacs/node-graceful-fs/issues/4
// Chown should not fail on einval or eperm if non-root.
// It should not fail on enosys ever, as this just indicates
// that a fs doesn't support the intended operation.

fs.chown = chownFix(fs.chown);
fs.fchown = chownFix(fs.fchown);
fs.lchown = chownFix(fs.lchown);

fs.chmod = chownFix(fs.chmod);
fs.fchmod = chownFix(fs.fchmod);
fs.lchmod = chownFix(fs.lchmod);

fs.chownSync = chownFixSync(fs.chownSync);
fs.fchownSync = chownFixSync(fs.fchownSync);
fs.lchownSync = chownFixSync(fs.lchownSync);

fs.chmodSync = chownFix(fs.chmodSync);
fs.fchmodSync = chownFix(fs.fchmodSync);
fs.lchmodSync = chownFix(fs.lchmodSync);

function chownFix (orig) {
  if (!orig) return orig
  return function (target, uid, gid, cb) {
    return orig.call(fs, target, uid, gid, function (er, res) {
      if (chownErOk(er)) er = null;
      cb(er, res);
    })
  }
}

function chownFixSync (orig) {
  if (!orig) return orig
  return function (target, uid, gid) {
    try {
      return orig.call(fs, target, uid, gid)
    } catch (er) {
      if (!chownErOk(er)) throw er
    }
  }
}

// ENOSYS means that the fs doesn't support the op. Just ignore
// that, because it doesn't matter.
//
// if there's no getuid, or if getuid() is something other
// than 0, and the error is EINVAL or EPERM, then just ignore
// it.
//
// This specific case is a silent failure in cp, install, tar,
// and most other unix tools that manage permissions.
//
// When running as root, or if other types of errors are
// encountered, then it's strict.
function chownErOk (er) {
  if (!er)
    return true

  if (er.code === "ENOSYS")
    return true

  var nonroot = !process.getuid || process.getuid() !== 0;
  if (nonroot) {
    if (er.code === "EINVAL" || er.code === "EPERM")
      return true
  }

  return false
}


// if lchmod/lchown do not exist, then make them no-ops
if (!fs.lchmod) {
  fs.lchmod = function (path, mode, cb) {
    process.nextTick(cb);
  };
  fs.lchmodSync = function () {};
}
if (!fs.lchown) {
  fs.lchown = function (path, uid, gid, cb) {
    process.nextTick(cb);
  };
  fs.lchownSync = function () {};
}



// on Windows, A/V software can lock the directory, causing this
// to fail with an EACCES or EPERM if the directory contains newly
// created files.  Try again on failure, for up to 1 second.
if (process.platform === "win32") {
  var rename_ = fs.rename;
  fs.rename = function rename (from, to, cb) {
    var start = Date.now();
    rename_(from, to, function CB (er) {
      if (er
          && (er.code === "EACCES" || er.code === "EPERM")
          && Date.now() - start < 1000) {
        return rename_(from, to, CB)
      }
      if(cb) cb(er);
    });
  };
}


// if read() returns EAGAIN, then just try it again.
var read = fs.read;
fs.read = function (fd, buffer, offset, length, position, callback_) {
  var callback;
  if (callback_ && typeof callback_ === 'function') {
    var eagCounter = 0;
    callback = function (er, _, __) {
      if (er && er.code === 'EAGAIN' && eagCounter < 10) {
        eagCounter ++;
        return read.call(fs, fd, buffer, offset, length, position, callback)
      }
      callback_.apply(this, arguments);
    };
  }
  return read.call(fs, fd, buffer, offset, length, position, callback)
};

var readSync = fs.readSync;
fs.readSync = function (fd, buffer, offset, length, position) {
  var eagCounter = 0;
  while (true) {
    try {
      return readSync.call(fs, fd, buffer, offset, length, position)
    } catch (er) {
      if (er.code === 'EAGAIN' && eagCounter < 10) {
        eagCounter ++;
        continue
      }
      throw er
    }
  }
};

var gracefulFs$1 = createCommonjsModule(function (module) {
// Monkey-patching the fs module.
// It's ugly, but there is simply no other way to do this.
var fs$1 = module.exports = fs;



// fix up some busted stuff, mostly on windows and old nodes




function noop () {}

var debug = noop;
if (util.debuglog)
  debug = util.debuglog('gfs');
else if (/\bgfs\b/i.test(process.env.NODE_DEBUG || ''))
  debug = function() {
    var m = util.format.apply(util, arguments);
    m = 'GFS: ' + m.split(/\n/).join('\nGFS: ');
    console.error(m);
  };

if (/\bgfs\b/i.test(process.env.NODE_DEBUG || '')) {
  process.on('exit', function() {
    debug('fds', fds);
    debug(queue);
    assert.equal(queue.length, 0);
  });
}


var originalOpen = fs$1.open;
fs$1.open = open;

function open(path, flags, mode, cb) {
  if (typeof mode === "function") cb = mode, mode = null;
  if (typeof cb !== "function") cb = noop;
  new OpenReq(path, flags, mode, cb);
}

function OpenReq(path, flags, mode, cb) {
  this.path = path;
  this.flags = flags;
  this.mode = mode;
  this.cb = cb;
  Req.call(this);
}

util.inherits(OpenReq, Req);

OpenReq.prototype.process = function() {
  originalOpen.call(fs$1, this.path, this.flags, this.mode, this.done);
};

var fds = {};
OpenReq.prototype.done = function(er, fd) {
  debug('open done', er, fd);
  if (fd)
    fds['fd' + fd] = this.path;
  Req.prototype.done.call(this, er, fd);
};


var originalReaddir = fs$1.readdir;
fs$1.readdir = readdir;

function readdir(path, cb) {
  if (typeof cb !== "function") cb = noop;
  new ReaddirReq(path, cb);
}

function ReaddirReq(path, cb) {
  this.path = path;
  this.cb = cb;
  Req.call(this);
}

util.inherits(ReaddirReq, Req);

ReaddirReq.prototype.process = function() {
  originalReaddir.call(fs$1, this.path, this.done);
};

ReaddirReq.prototype.done = function(er, files) {
  if (files && files.sort)
    files = files.sort();
  Req.prototype.done.call(this, er, files);
  onclose();
};


var originalClose = fs$1.close;
fs$1.close = close;

function close (fd, cb) {
  debug('close', fd);
  if (typeof cb !== "function") cb = noop;
  delete fds['fd' + fd];
  originalClose.call(fs$1, fd, function(er) {
    onclose();
    cb(er);
  });
}


var originalCloseSync = fs$1.closeSync;
fs$1.closeSync = closeSync;

function closeSync (fd) {
  try {
    return originalCloseSync(fd)
  } finally {
    onclose();
  }
}


// Req class
function Req () {
  // start processing
  this.done = this.done.bind(this);
  this.failures = 0;
  this.process();
}

Req.prototype.done = function (er, result) {
  var tryAgain = false;
  if (er) {
    var code = er.code;
    var tryAgain = code === "EMFILE" || code === "ENFILE";
    if (process.platform === "win32")
      tryAgain = tryAgain || code === "OK";
  }

  if (tryAgain) {
    this.failures ++;
    enqueue(this);
  } else {
    var cb = this.cb;
    cb(er, result);
  }
};

var queue = [];

function enqueue(req) {
  queue.push(req);
  debug('enqueue %d %s', queue.length, req.constructor.name, req);
}

function onclose() {
  var req = queue.shift();
  if (req) {
    debug('process', req.constructor.name, req);
    req.process();
  }
}
});

var octal_0777 = parseInt('0777', 8);

function mkdirs(p, opts, f, made) {
  if (typeof opts === 'function') {
    f = opts;
    opts = {};
  }
  else if (!opts || typeof opts !== 'object') {
    opts = { mode: opts };
  }

  var mode = opts.mode;
  var xfs = opts.fs || gracefulFs$1;

  if (mode === undefined) {
    mode = octal_0777 & (~process.umask());
  }
  if (!made) made = null;

  var cb = f || function () {};
  p = path$1.resolve(p);

  xfs.mkdir(p, mode, function (er) {
    if (!er) {
      made = made || p;
      return cb(null, made)
    }
    switch (er.code) {
      case 'ENOENT':
        if (path$1.dirname(p) == p) return cb(er)
        mkdirs(path$1.dirname(p), opts, function (er, made) {
          if (er) cb(er, made);
          else mkdirs(p, opts, cb, made);
        });
        break

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        xfs.stat(p, function (er2, stat) {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason.
          if (er2 || !stat.isDirectory()) cb(er, made);
          else cb(null, made);
        });
        break
    }
  });
}

function mkdirsSync (p, opts, made) {
  if (!opts || typeof opts !== 'object') {
    opts = { mode: opts };
  }

  var mode = opts.mode;
  var xfs = opts.fs || gracefulFs$1;

  if (mode === undefined) {
    mode = octal_0777 & (~process.umask());
  }
  if (!made) made = null;

  p = path$1.resolve(p);

  try {
    xfs.mkdirSync(p, mode);
    made = made || p;
  }
  catch (err0) {
    switch (err0.code) {
      case 'ENOENT' :
        made = mkdirsSync(path$1.dirname(p), opts, made);
        mkdirsSync(p, opts, made);
        break

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        var stat;
        try {
          stat = xfs.statSync(p);
        }
        catch (err1) {
          throw err0
        }
        if (!stat.isDirectory()) throw err0
        break
    }
  }

  return made
}

var mkdir = {
  mkdirs: mkdirs,
  mkdirsSync: mkdirsSync
};

function outputJsonSync(file, data) {
  var dir = path$1.dirname(file);

  if (!gracefulFs$1.existsSync(dir))
    mkdir.mkdirsSync(dir);

  jsonfile_1.writeFileSync(file, data);
}

function outputJson(file, data, callback) {
  var dir = path$1.dirname(file);

  gracefulFs$1.exists(dir, function(itDoes) {
    if (itDoes) return jsonfile_1.writeFile(file, data, callback)

    mkdir.mkdirs(dir, function(err) {
      if (err) return callback(err)
      jsonfile_1.writeFile(file, data, callback);
    });
  });
}

var json = {
  outputJsonSync: outputJsonSync,
  outputJson: outputJson
};

// imported from ncp (this is temporary, will rewrite)




function ncp (source, dest, options, callback) {
  var cback = callback;

  if (!callback) {
    cback = options;
    options = {};
  }

  var basePath = process.cwd();
  var currentPath = path$1.resolve(basePath, source);
  var targetPath = path$1.resolve(basePath, dest);

  var filter = options.filter;
  var transform = options.transform;
  var clobber = options.clobber !== false;
  var dereference = options.dereference;

  var errs = null;
  
  var started = 0;
  var finished = 0;
  var running = 0;
  // this is pretty useless now that we're using graceful-fs
  // consider removing
  var limit = options.limit || 512;

  startCopy(currentPath);
  
  function startCopy(source) {
    started++;
    if (filter) {
      if (filter instanceof RegExp) {
        if (!filter.test(source)) {
          return cb(true)
        }
      }
      else if (typeof filter === 'function') {
        if (!filter(source)) {
          return cb(true)
        }
      }
    }
    return getStats(source)
  }

  function getStats(source) {
    var defer = commonjsGlobal.setImmediate || process.nextTick;
    var stat = dereference ? gracefulFs$1.stat : gracefulFs$1.lstat;
    if (running >= limit) {
      return defer(function () {
        getStats(source);
      })
    }
    running++;
    stat(source, function (err, stats) {
      var item = {};
      if (err) {
        return onError(err)
      }

      // We need to get the mode from the stats object and preserve it.
      item.name = source;
      item.mode = stats.mode;
      item.mtime = stats.mtime; //modified time
      item.atime = stats.atime; //access time

      if (stats.isDirectory()) {
        return onDir(item)
      }
      else if (stats.isFile()) {
        return onFile(item)
      }
      else if (stats.isSymbolicLink()) {
        // Symlinks don't really need to know about the mode.
        return onLink(source)
      }
    });
  }

  function onFile(file) {
    var target = file.name.replace(currentPath, targetPath);
    isWritable(target, function (writable) {
      if (writable) {
        copyFile(file, target);
      } else {
        if(clobber) {
          rmFile(target, function () {
            copyFile(file, target);
          });
        } else {
          cb();
        }
      }
    });
  }

  function copyFile(file, target) {
    var readStream = gracefulFs$1.createReadStream(file.name),
        writeStream = gracefulFs$1.createWriteStream(target, { mode: file.mode });
    
    readStream.on('error', onError);
    writeStream.on('error', onError);
    
    if(transform) {
      transform(readStream, writeStream, file);
    } else {
      writeStream.on('open', function() {
        readStream.pipe(writeStream);
      });
    }

    //presumably old node then
    var eventName = commonjsGlobal.setImmediate ? 'finish' : 'close';
    writeStream.once(eventName, function() {
      cb();
    });
  }

  function rmFile(file, done) {
    gracefulFs$1.unlink(file, function (err) {
      if (err) {
        return onError(err)
      }
      return done()
    });
  }

  function onDir(dir) {
    var target = dir.name.replace(currentPath, targetPath);
    isWritable(target, function (writable) {
      if (writable) {
        return mkDir(dir, target)
      }
      copyDir(dir.name);
    });
  }

  function mkDir(dir, target) {
    gracefulFs$1.mkdir(target, dir.mode, function (err) {
      if (err) {
        return onError(err)
      }
      copyDir(dir.name);
    });
  }

  function copyDir(dir) {
    gracefulFs$1.readdir(dir, function (err, items) {
      if (err) {
        return onError(err)
      }
      items.forEach(function (item) {
        startCopy(path$1.join(dir, item));
      });
      return cb()
    });
  }

  function onLink(link) {
    var target = link.replace(currentPath, targetPath);
    gracefulFs$1.readlink(link, function (err, resolvedPath) {
      if (err) {
        return onError(err)
      }
      checkLink(resolvedPath, target);
    });
  }

  function checkLink(resolvedPath, target) {
    if (dereference) {
      resolvedPath = path$1.resolve(basePath, resolvedPath);
    }
    isWritable(target, function (writable) {
      if (writable) {
        return makeLink(resolvedPath, target)
      }
      gracefulFs$1.readlink(target, function (err, targetDest) {
        if (err) {
          return onError(err)
        }
        if (dereference) {
          targetDest = path$1.resolve(basePath, targetDest);
        }
        if (targetDest === resolvedPath) {
          return cb()
        }
        return rmFile(target, function () {
          makeLink(resolvedPath, target);
        })
      });
    });
  }

  function makeLink(linkPath, target) {
    gracefulFs$1.symlink(linkPath, target, function (err) {
      if (err) {
        return onError(err)
      }
      return cb()
    });
  }

  function isWritable(path, done) {
    gracefulFs$1.lstat(path, function (err) {
      if (err) {
        if (err.code === 'ENOENT') return done(true)
        return done(false)
      }
      return done(false)
    });
  }

  function onError(err) {
    if (options.stopOnError) {
      return cback(err)
    }
    else if (!errs && options.errs) {
      errs = gracefulFs$1.createWriteStream(options.errs);
    }
    else if (!errs) {
      errs = [];
    }
    if (typeof errs.write === 'undefined') {
      errs.push(err);
    }
    else { 
      errs.write(err.stack + '\n\n');
    }
    return cb()
  }

  function cb(skipped) {
    if (!skipped) running--;
    finished++;
    if ((started === finished) && (running === 0)) {
      if (cback !== undefined ) {
        return errs ? cback(errs) : cback(null)
      }
    }
  }
}

// todo, make this just export ncp
var ncp_1 = ncp;

var _copy = {
	ncp: ncp_1
};

function createFile (file, callback) {
  function makeFile() {
    gracefulFs$1.writeFile(file, '', function(err) {
      if (err) return callback(err)
      callback();
    });
  }

  gracefulFs$1.exists(file, function(fileExists) {
    if (fileExists) return callback()
    var dir = path$1.dirname(file);
    gracefulFs$1.exists(dir, function(dirExists) {
      if (dirExists) return makeFile()
      mkdir.mkdirs(dir, function(err) {
        if (err) return callback(err)
        makeFile();
      });
    });
  });
}

function createFileSync (file) {
  if (gracefulFs$1.existsSync(file)) return

  var dir = path$1.dirname(file);
  if (!gracefulFs$1.existsSync(dir))
    mkdir.mkdirsSync(dir);

  gracefulFs$1.writeFileSync(file, '');
}

var create = {
  createFile: createFile,
  createFileSync: createFileSync
};

var ncp$1 = _copy.ncp;



var BUF_LENGTH = 64 * 1024;
var _buff = new Buffer(BUF_LENGTH);

var copyFileSync = function(srcFile, destFile) {
  var fdr = gracefulFs$1.openSync(srcFile, 'r');
  var stat = gracefulFs$1.fstatSync(fdr);
  var fdw = gracefulFs$1.openSync(destFile, 'w', stat.mode);
  var bytesRead = 1;
  var pos = 0;

  while (bytesRead > 0) {
    bytesRead = gracefulFs$1.readSync(fdr, _buff, 0, BUF_LENGTH, pos);
    gracefulFs$1.writeSync(fdw, _buff, 0, bytesRead);
    pos += bytesRead;
  }

  gracefulFs$1.closeSync(fdr);
  gracefulFs$1.closeSync(fdw);
};

function copy(src, dest, options, callback) {
  if( typeof options == "function" && !callback) {
    callback = options;
    options = {};
  } else if (typeof options == "function" || options instanceof RegExp) {
    options = {filter: options};
  }
  callback = callback || function(){};

  gracefulFs$1.lstat(src, function(err, stats) {
    if (err) return callback(err)

    var dir = null;
    if (stats.isDirectory()) {
      var parts = dest.split(path$1.sep);
      parts.pop();
      dir = parts.join(path$1.sep);
    } else {
      dir = path$1.dirname(dest);
    }

    gracefulFs$1.exists(dir, function(dirExists) {
      if (dirExists) return ncp$1(src, dest, options, callback)
      mkdir.mkdirs(dir, function(err) {
        if (err) return callback(err)
        ncp$1(src, dest, options, callback);
      });
    });
  });
}

function copySync(src, dest, options) {
  if (typeof options == "function" || options instanceof RegExp) {
    options = {filter: options};
  }

  options = options || {};
  options.recursive = !!options.recursive;

  options.filter = options.filter || function() { return true };

  var stats = options.recursive ? gracefulFs$1.lstatSync(src) : gracefulFs$1.statSync(src);
  var destFolder = path$1.dirname(dest);
  var destFolderExists = gracefulFs$1.existsSync(destFolder);
  var performCopy = false;

  if (stats.isFile()) {
    if (options.filter instanceof RegExp) performCopy = options.filter.test(src);
    else if (typeof options.filter == "function") performCopy = options.filter(src);

    if (performCopy) {
      if (!destFolderExists) mkdir.mkdirsSync(destFolder);
      copyFileSync(src, dest);
    }
  }
  else if (stats.isDirectory()) {
    if (!gracefulFs$1.existsSync(dest)) mkdir.mkdirsSync(dest);
    var contents = gracefulFs$1.readdirSync(src);
    contents.forEach(function(content) {
      copySync(path$1.join(src, content), path$1.join(dest, content), {filter: options.filter, recursive: true});
    });
  }
  else if (options.recursive && stats.isSymbolicLink()) {
    var srcPath = gracefulFs$1.readlinkSync(src);
    gracefulFs$1.symlinkSync(srcPath, dest);
  }
}

var copy_1 = {
  copy: copy,
  copySync: copySync
};

// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.


var isWindows = process.platform === 'win32';


// JavaScript implementation of realpath, ported from node pre-v6

var DEBUG = process.env.NODE_DEBUG && /fs/.test(process.env.NODE_DEBUG);

function rethrow() {
  // Only enable in debug mode. A backtrace uses ~1000 bytes of heap space and
  // is fairly slow to generate.
  var callback;
  if (DEBUG) {
    var backtrace = new Error;
    callback = debugCallback;
  } else
    callback = missingCallback;

  return callback;

  function debugCallback(err) {
    if (err) {
      backtrace.message = err.message;
      err = backtrace;
      missingCallback(err);
    }
  }

  function missingCallback(err) {
    if (err) {
      if (process.throwDeprecation)
        throw err;  // Forgot a callback but don't know where? Use NODE_DEBUG=fs
      else if (!process.noDeprecation) {
        var msg = 'fs: missing callback ' + (err.stack || err.message);
        if (process.traceDeprecation)
          console.trace(msg);
        else
          console.error(msg);
      }
    }
  }
}

function maybeCallback(cb) {
  return typeof cb === 'function' ? cb : rethrow();
}

var normalize = path$1.normalize;

// Regexp that finds the next partion of a (partial) path
// result is [base_with_slash, base], e.g. ['somedir/', 'somedir']
if (isWindows) {
  var nextPartRe = /(.*?)(?:[\/\\]+|$)/g;
} else {
  var nextPartRe = /(.*?)(?:[\/]+|$)/g;
}

// Regex to find the device root, including trailing slash. E.g. 'c:\\'.
if (isWindows) {
  var splitRootRe = /^(?:[a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/][^\\\/]+)?[\\\/]*/;
} else {
  var splitRootRe = /^[\/]*/;
}

var realpathSync = function realpathSync(p, cache) {
  // make p is absolute
  p = path$1.resolve(p);

  if (cache && Object.prototype.hasOwnProperty.call(cache, p)) {
    return cache[p];
  }

  var original = p,
      seenLinks = {},
      knownHard = {};

  // current character position in p
  var pos;
  // the partial path so far, including a trailing slash if any
  var current;
  // the partial path without a trailing slash (except when pointing at a root)
  var base;
  // the partial path scanned in the previous round, with slash
  var previous;

  start();

  function start() {
    // Skip over roots
    var m = splitRootRe.exec(p);
    pos = m[0].length;
    current = m[0];
    base = m[0];
    previous = '';

    // On windows, check that the root exists. On unix there is no need.
    if (isWindows && !knownHard[base]) {
      fs$2.lstatSync(base);
      knownHard[base] = true;
    }
  }

  // walk down the path, swapping out linked pathparts for their real
  // values
  // NB: p.length changes.
  while (pos < p.length) {
    // find the next part
    nextPartRe.lastIndex = pos;
    var result = nextPartRe.exec(p);
    previous = current;
    current += result[0];
    base = previous + result[1];
    pos = nextPartRe.lastIndex;

    // continue if not a symlink
    if (knownHard[base] || (cache && cache[base] === base)) {
      continue;
    }

    var resolvedLink;
    if (cache && Object.prototype.hasOwnProperty.call(cache, base)) {
      // some known symbolic link.  no need to stat again.
      resolvedLink = cache[base];
    } else {
      var stat = fs$2.lstatSync(base);
      if (!stat.isSymbolicLink()) {
        knownHard[base] = true;
        if (cache) cache[base] = base;
        continue;
      }

      // read the link if it wasn't read before
      // dev/ino always return 0 on windows, so skip the check.
      var linkTarget = null;
      if (!isWindows) {
        var id = stat.dev.toString(32) + ':' + stat.ino.toString(32);
        if (seenLinks.hasOwnProperty(id)) {
          linkTarget = seenLinks[id];
        }
      }
      if (linkTarget === null) {
        fs$2.statSync(base);
        linkTarget = fs$2.readlinkSync(base);
      }
      resolvedLink = path$1.resolve(previous, linkTarget);
      // track this, if given a cache.
      if (cache) cache[base] = resolvedLink;
      if (!isWindows) seenLinks[id] = linkTarget;
    }

    // resolve the link, then start over
    p = path$1.resolve(resolvedLink, p.slice(pos));
    start();
  }

  if (cache) cache[original] = p;

  return p;
};


var realpath = function realpath(p, cache, cb) {
  if (typeof cb !== 'function') {
    cb = maybeCallback(cache);
    cache = null;
  }

  // make p is absolute
  p = path$1.resolve(p);

  if (cache && Object.prototype.hasOwnProperty.call(cache, p)) {
    return process.nextTick(cb.bind(null, null, cache[p]));
  }

  var original = p,
      seenLinks = {},
      knownHard = {};

  // current character position in p
  var pos;
  // the partial path so far, including a trailing slash if any
  var current;
  // the partial path without a trailing slash (except when pointing at a root)
  var base;
  // the partial path scanned in the previous round, with slash
  var previous;

  start();

  function start() {
    // Skip over roots
    var m = splitRootRe.exec(p);
    pos = m[0].length;
    current = m[0];
    base = m[0];
    previous = '';

    // On windows, check that the root exists. On unix there is no need.
    if (isWindows && !knownHard[base]) {
      fs$2.lstat(base, function(err) {
        if (err) return cb(err);
        knownHard[base] = true;
        LOOP();
      });
    } else {
      process.nextTick(LOOP);
    }
  }

  // walk down the path, swapping out linked pathparts for their real
  // values
  function LOOP() {
    // stop if scanned past end of path
    if (pos >= p.length) {
      if (cache) cache[original] = p;
      return cb(null, p);
    }

    // find the next part
    nextPartRe.lastIndex = pos;
    var result = nextPartRe.exec(p);
    previous = current;
    current += result[0];
    base = previous + result[1];
    pos = nextPartRe.lastIndex;

    // continue if not a symlink
    if (knownHard[base] || (cache && cache[base] === base)) {
      return process.nextTick(LOOP);
    }

    if (cache && Object.prototype.hasOwnProperty.call(cache, base)) {
      // known symbolic link.  no need to stat again.
      return gotResolvedLink(cache[base]);
    }

    return fs$2.lstat(base, gotStat);
  }

  function gotStat(err, stat) {
    if (err) return cb(err);

    // if not a symlink, skip to the next path part
    if (!stat.isSymbolicLink()) {
      knownHard[base] = true;
      if (cache) cache[base] = base;
      return process.nextTick(LOOP);
    }

    // stat & read the link if not read before
    // call gotTarget as soon as the link target is known
    // dev/ino always return 0 on windows, so skip the check.
    if (!isWindows) {
      var id = stat.dev.toString(32) + ':' + stat.ino.toString(32);
      if (seenLinks.hasOwnProperty(id)) {
        return gotTarget(null, seenLinks[id], base);
      }
    }
    fs$2.stat(base, function(err) {
      if (err) return cb(err);

      fs$2.readlink(base, function(err, target) {
        if (!isWindows) seenLinks[id] = target;
        gotTarget(err, target);
      });
    });
  }

  function gotTarget(err, target, base) {
    if (err) return cb(err);

    var resolvedLink = path$1.resolve(previous, target);
    if (cache) cache[base] = resolvedLink;
    gotResolvedLink(resolvedLink);
  }

  function gotResolvedLink(resolvedLink) {
    // resolve the link, then start over
    p = path$1.resolve(resolvedLink, p.slice(pos));
    start();
  }
};

var old = {
	realpathSync: realpathSync,
	realpath: realpath
};

var fs_realpath = realpath$1;
realpath$1.realpath = realpath$1;
realpath$1.sync = realpathSync$1;
realpath$1.realpathSync = realpathSync$1;
realpath$1.monkeypatch = monkeypatch;
realpath$1.unmonkeypatch = unmonkeypatch;


var origRealpath = fs$2.realpath;
var origRealpathSync = fs$2.realpathSync;

var version = process.version;
var ok = /^v[0-5]\./.test(version);


function newError (er) {
  return er && er.syscall === 'realpath' && (
    er.code === 'ELOOP' ||
    er.code === 'ENOMEM' ||
    er.code === 'ENAMETOOLONG'
  )
}

function realpath$1 (p, cache, cb) {
  if (ok) {
    return origRealpath(p, cache, cb)
  }

  if (typeof cache === 'function') {
    cb = cache;
    cache = null;
  }
  origRealpath(p, cache, function (er, result) {
    if (newError(er)) {
      old.realpath(p, cache, cb);
    } else {
      cb(er, result);
    }
  });
}

function realpathSync$1 (p, cache) {
  if (ok) {
    return origRealpathSync(p, cache)
  }

  try {
    return origRealpathSync(p, cache)
  } catch (er) {
    if (newError(er)) {
      return old.realpathSync(p, cache)
    } else {
      throw er
    }
  }
}

function monkeypatch () {
  fs$2.realpath = realpath$1;
  fs$2.realpathSync = realpathSync$1;
}

function unmonkeypatch () {
  fs$2.realpath = origRealpath;
  fs$2.realpathSync = origRealpathSync;
}

var concatMap = function (xs, fn) {
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        var x = fn(xs[i], i);
        if (isArray(x)) res.push.apply(res, x);
        else res.push(x);
    }
    return res;
};

var isArray = Array.isArray || function (xs) {
    return Object.prototype.toString.call(xs) === '[object Array]';
};

var balancedMatch = balanced;
function balanced(a, b, str) {
  if (a instanceof RegExp) a = maybeMatch(a, str);
  if (b instanceof RegExp) b = maybeMatch(b, str);

  var r = range(a, b, str);

  return r && {
    start: r[0],
    end: r[1],
    pre: str.slice(0, r[0]),
    body: str.slice(r[0] + a.length, r[1]),
    post: str.slice(r[1] + b.length)
  };
}

function maybeMatch(reg, str) {
  var m = str.match(reg);
  return m ? m[0] : null;
}

balanced.range = range;
function range(a, b, str) {
  var begs, beg, left, right, result;
  var ai = str.indexOf(a);
  var bi = str.indexOf(b, ai + 1);
  var i = ai;

  if (ai >= 0 && bi > 0) {
    begs = [];
    left = str.length;

    while (i >= 0 && !result) {
      if (i == ai) {
        begs.push(i);
        ai = str.indexOf(a, i + 1);
      } else if (begs.length == 1) {
        result = [ begs.pop(), bi ];
      } else {
        beg = begs.pop();
        if (beg < left) {
          left = beg;
          right = bi;
        }

        bi = str.indexOf(b, i + 1);
      }

      i = ai < bi && ai >= 0 ? ai : bi;
    }

    if (begs.length) {
      result = [ left, right ];
    }
  }

  return result;
}

var braceExpansion = expandTop;

var escSlash = '\0SLASH'+Math.random()+'\0';
var escOpen = '\0OPEN'+Math.random()+'\0';
var escClose = '\0CLOSE'+Math.random()+'\0';
var escComma = '\0COMMA'+Math.random()+'\0';
var escPeriod = '\0PERIOD'+Math.random()+'\0';

function numeric(str) {
  return parseInt(str, 10) == str
    ? parseInt(str, 10)
    : str.charCodeAt(0);
}

function escapeBraces(str) {
  return str.split('\\\\').join(escSlash)
            .split('\\{').join(escOpen)
            .split('\\}').join(escClose)
            .split('\\,').join(escComma)
            .split('\\.').join(escPeriod);
}

function unescapeBraces(str) {
  return str.split(escSlash).join('\\')
            .split(escOpen).join('{')
            .split(escClose).join('}')
            .split(escComma).join(',')
            .split(escPeriod).join('.');
}


// Basically just str.split(","), but handling cases
// where we have nested braced sections, which should be
// treated as individual members, like {a,{b,c},d}
function parseCommaParts(str) {
  if (!str)
    return [''];

  var parts = [];
  var m = balancedMatch('{', '}', str);

  if (!m)
    return str.split(',');

  var pre = m.pre;
  var body = m.body;
  var post = m.post;
  var p = pre.split(',');

  p[p.length-1] += '{' + body + '}';
  var postParts = parseCommaParts(post);
  if (post.length) {
    p[p.length-1] += postParts.shift();
    p.push.apply(p, postParts);
  }

  parts.push.apply(parts, p);

  return parts;
}

function expandTop(str) {
  if (!str)
    return [];

  // I don't know why Bash 4.3 does this, but it does.
  // Anything starting with {} will have the first two bytes preserved
  // but *only* at the top level, so {},a}b will not expand to anything,
  // but a{},b}c will be expanded to [a}c,abc].
  // One could argue that this is a bug in Bash, but since the goal of
  // this module is to match Bash's rules, we escape a leading {}
  if (str.substr(0, 2) === '{}') {
    str = '\\{\\}' + str.substr(2);
  }

  return expand(escapeBraces(str), true).map(unescapeBraces);
}

function embrace(str) {
  return '{' + str + '}';
}
function isPadded(el) {
  return /^-?0\d/.test(el);
}

function lte(i, y) {
  return i <= y;
}
function gte(i, y) {
  return i >= y;
}

function expand(str, isTop) {
  var expansions = [];

  var m = balancedMatch('{', '}', str);
  if (!m || /\$$/.test(m.pre)) return [str];

  var isNumericSequence = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/.test(m.body);
  var isAlphaSequence = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/.test(m.body);
  var isSequence = isNumericSequence || isAlphaSequence;
  var isOptions = m.body.indexOf(',') >= 0;
  if (!isSequence && !isOptions) {
    // {a},b}
    if (m.post.match(/,.*\}/)) {
      str = m.pre + '{' + m.body + escClose + m.post;
      return expand(str);
    }
    return [str];
  }

  var n;
  if (isSequence) {
    n = m.body.split(/\.\./);
  } else {
    n = parseCommaParts(m.body);
    if (n.length === 1) {
      // x{{a,b}}y ==> x{a}y x{b}y
      n = expand(n[0], false).map(embrace);
      if (n.length === 1) {
        var post = m.post.length
          ? expand(m.post, false)
          : [''];
        return post.map(function(p) {
          return m.pre + n[0] + p;
        });
      }
    }
  }

  // at this point, n is the parts, and we know it's not a comma set
  // with a single entry.

  // no need to expand pre, since it is guaranteed to be free of brace-sets
  var pre = m.pre;
  var post = m.post.length
    ? expand(m.post, false)
    : [''];

  var N;

  if (isSequence) {
    var x = numeric(n[0]);
    var y = numeric(n[1]);
    var width = Math.max(n[0].length, n[1].length);
    var incr = n.length == 3
      ? Math.abs(numeric(n[2]))
      : 1;
    var test = lte;
    var reverse = y < x;
    if (reverse) {
      incr *= -1;
      test = gte;
    }
    var pad = n.some(isPadded);

    N = [];

    for (var i = x; test(i, y); i += incr) {
      var c;
      if (isAlphaSequence) {
        c = String.fromCharCode(i);
        if (c === '\\')
          c = '';
      } else {
        c = String(i);
        if (pad) {
          var need = width - c.length;
          if (need > 0) {
            var z = new Array(need + 1).join('0');
            if (i < 0)
              c = '-' + z + c.slice(1);
            else
              c = z + c;
          }
        }
      }
      N.push(c);
    }
  } else {
    N = concatMap(n, function(el) { return expand(el, false) });
  }

  for (var j = 0; j < N.length; j++) {
    for (var k = 0; k < post.length; k++) {
      var expansion = pre + N[j] + post[k];
      if (!isTop || isSequence || expansion)
        expansions.push(expansion);
    }
  }

  return expansions;
}

var minimatch_1 = minimatch;
minimatch.Minimatch = Minimatch;

var path = { sep: '/' };
try {
  path = path$1;
} catch (er) {}

var GLOBSTAR = minimatch.GLOBSTAR = Minimatch.GLOBSTAR = {};


var plTypes = {
  '!': { open: '(?:(?!(?:', close: '))[^/]*?)'},
  '?': { open: '(?:', close: ')?' },
  '+': { open: '(?:', close: ')+' },
  '*': { open: '(?:', close: ')*' },
  '@': { open: '(?:', close: ')' }
};

// any single thing other than /
// don't need to escape / when using new RegExp()
var qmark = '[^/]';

// * => any number of characters
var star = qmark + '*?';

// ** when dots are allowed.  Anything goes, except .. and .
// not (^ or / followed by one or two dots followed by $ or /),
// followed by anything, any number of times.
var twoStarDot = '(?:(?!(?:\\\/|^)(?:\\.{1,2})($|\\\/)).)*?';

// not a ^ or / followed by a dot,
// followed by anything, any number of times.
var twoStarNoDot = '(?:(?!(?:\\\/|^)\\.).)*?';

// characters that need to be escaped in RegExp.
var reSpecials = charSet('().*{}+?[]^$\\!');

// "abc" -> { a:true, b:true, c:true }
function charSet (s) {
  return s.split('').reduce(function (set, c) {
    set[c] = true;
    return set
  }, {})
}

// normalizes slashes.
var slashSplit = /\/+/;

minimatch.filter = filter;
function filter (pattern, options) {
  options = options || {};
  return function (p, i, list) {
    return minimatch(p, pattern, options)
  }
}

function ext (a, b) {
  a = a || {};
  b = b || {};
  var t = {};
  Object.keys(b).forEach(function (k) {
    t[k] = b[k];
  });
  Object.keys(a).forEach(function (k) {
    t[k] = a[k];
  });
  return t
}

minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return minimatch

  var orig = minimatch;

  var m = function minimatch (p, pattern, options) {
    return orig.minimatch(p, pattern, ext(def, options))
  };

  m.Minimatch = function Minimatch (pattern, options) {
    return new orig.Minimatch(pattern, ext(def, options))
  };

  return m
};

Minimatch.defaults = function (def) {
  if (!def || !Object.keys(def).length) return Minimatch
  return minimatch.defaults(def).Minimatch
};

function minimatch (p, pattern, options) {
  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {};

  // shortcut: comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    return false
  }

  // "" only matches ""
  if (pattern.trim() === '') return p === ''

  return new Minimatch(pattern, options).match(p)
}

function Minimatch (pattern, options) {
  if (!(this instanceof Minimatch)) {
    return new Minimatch(pattern, options)
  }

  if (typeof pattern !== 'string') {
    throw new TypeError('glob pattern string required')
  }

  if (!options) options = {};
  pattern = pattern.trim();

  // windows support: need to use /, not \
  if (path.sep !== '/') {
    pattern = pattern.split(path.sep).join('/');
  }

  this.options = options;
  this.set = [];
  this.pattern = pattern;
  this.regexp = null;
  this.negate = false;
  this.comment = false;
  this.empty = false;

  // make the set of regexps etc.
  this.make();
}

Minimatch.prototype.debug = function () {};

Minimatch.prototype.make = make;
function make () {
  // don't do it more than once.
  if (this._made) return

  var pattern = this.pattern;
  var options = this.options;

  // empty patterns and comments match nothing.
  if (!options.nocomment && pattern.charAt(0) === '#') {
    this.comment = true;
    return
  }
  if (!pattern) {
    this.empty = true;
    return
  }

  // step 1: figure out negation, etc.
  this.parseNegate();

  // step 2: expand braces
  var set = this.globSet = this.braceExpand();

  if (options.debug) this.debug = console.error;

  this.debug(this.pattern, set);

  // step 3: now we have a set, so turn each one into a series of path-portion
  // matching patterns.
  // These will be regexps, except in the case of "**", which is
  // set to the GLOBSTAR object for globstar behavior,
  // and will not contain any / characters
  set = this.globParts = set.map(function (s) {
    return s.split(slashSplit)
  });

  this.debug(this.pattern, set);

  // glob --> regexps
  set = set.map(function (s, si, set) {
    return s.map(this.parse, this)
  }, this);

  this.debug(this.pattern, set);

  // filter out everything that didn't compile properly.
  set = set.filter(function (s) {
    return s.indexOf(false) === -1
  });

  this.debug(this.pattern, set);

  this.set = set;
}

Minimatch.prototype.parseNegate = parseNegate;
function parseNegate () {
  var pattern = this.pattern;
  var negate = false;
  var options = this.options;
  var negateOffset = 0;

  if (options.nonegate) return

  for (var i = 0, l = pattern.length
    ; i < l && pattern.charAt(i) === '!'
    ; i++) {
    negate = !negate;
    negateOffset++;
  }

  if (negateOffset) this.pattern = pattern.substr(negateOffset);
  this.negate = negate;
}

// Brace expansion:
// a{b,c}d -> abd acd
// a{b,}c -> abc ac
// a{0..3}d -> a0d a1d a2d a3d
// a{b,c{d,e}f}g -> abg acdfg acefg
// a{b,c}d{e,f}g -> abdeg acdeg abdeg abdfg
//
// Invalid sets are not expanded.
// a{2..}b -> a{2..}b
// a{b}c -> a{b}c
minimatch.braceExpand = function (pattern, options) {
  return braceExpand(pattern, options)
};

Minimatch.prototype.braceExpand = braceExpand;

function braceExpand (pattern, options) {
  if (!options) {
    if (this instanceof Minimatch) {
      options = this.options;
    } else {
      options = {};
    }
  }

  pattern = typeof pattern === 'undefined'
    ? this.pattern : pattern;

  if (typeof pattern === 'undefined') {
    throw new TypeError('undefined pattern')
  }

  if (options.nobrace ||
    !pattern.match(/\{.*\}/)) {
    // shortcut. no need to expand.
    return [pattern]
  }

  return braceExpansion(pattern)
}

// parse a component of the expanded set.
// At this point, no pattern may contain "/" in it
// so we're going to return a 2d array, where each entry is the full
// pattern, split on '/', and then turned into a regular expression.
// A regexp is made at the end which joins each array with an
// escaped /, and another full one which joins each regexp with |.
//
// Following the lead of Bash 4.1, note that "**" only has special meaning
// when it is the *only* thing in a path portion.  Otherwise, any series
// of * is equivalent to a single *.  Globstar behavior is enabled by
// default, and can be disabled by setting options.noglobstar.
Minimatch.prototype.parse = parse;
var SUBPARSE = {};
function parse (pattern, isSub) {
  if (pattern.length > 1024 * 64) {
    throw new TypeError('pattern is too long')
  }

  var options = this.options;

  // shortcuts
  if (!options.noglobstar && pattern === '**') return GLOBSTAR
  if (pattern === '') return ''

  var re = '';
  var hasMagic = !!options.nocase;
  var escaping = false;
  // ? => one single character
  var patternListStack = [];
  var negativeLists = [];
  var stateChar;
  var inClass = false;
  var reClassStart = -1;
  var classStart = -1;
  // . and .. never match anything that doesn't start with .,
  // even when options.dot is set.
  var patternStart = pattern.charAt(0) === '.' ? '' // anything
  // not (start or / followed by . or .. followed by / or end)
  : options.dot ? '(?!(?:^|\\\/)\\.{1,2}(?:$|\\\/))'
  : '(?!\\.)';
  var self = this;

  function clearStateChar () {
    if (stateChar) {
      // we had some state-tracking character
      // that wasn't consumed by this pass.
      switch (stateChar) {
        case '*':
          re += star;
          hasMagic = true;
        break
        case '?':
          re += qmark;
          hasMagic = true;
        break
        default:
          re += '\\' + stateChar;
        break
      }
      self.debug('clearStateChar %j %j', stateChar, re);
      stateChar = false;
    }
  }

  for (var i = 0, len = pattern.length, c
    ; (i < len) && (c = pattern.charAt(i))
    ; i++) {
    this.debug('%s\t%s %s %j', pattern, i, re, c);

    // skip over any that are escaped.
    if (escaping && reSpecials[c]) {
      re += '\\' + c;
      escaping = false;
      continue
    }

    switch (c) {
      case '/':
        // completely not allowed, even escaped.
        // Should already be path-split by now.
        return false

      case '\\':
        clearStateChar();
        escaping = true;
      continue

      // the various stateChar values
      // for the "extglob" stuff.
      case '?':
      case '*':
      case '+':
      case '@':
      case '!':
        this.debug('%s\t%s %s %j <-- stateChar', pattern, i, re, c);

        // all of those are literals inside a class, except that
        // the glob [!a] means [^a] in regexp
        if (inClass) {
          this.debug('  in class');
          if (c === '!' && i === classStart + 1) c = '^';
          re += c;
          continue
        }

        // if we already have a stateChar, then it means
        // that there was something like ** or +? in there.
        // Handle the stateChar, then proceed with this one.
        self.debug('call clearStateChar %j', stateChar);
        clearStateChar();
        stateChar = c;
        // if extglob is disabled, then +(asdf|foo) isn't a thing.
        // just clear the statechar *now*, rather than even diving into
        // the patternList stuff.
        if (options.noext) clearStateChar();
      continue

      case '(':
        if (inClass) {
          re += '(';
          continue
        }

        if (!stateChar) {
          re += '\\(';
          continue
        }

        patternListStack.push({
          type: stateChar,
          start: i - 1,
          reStart: re.length,
          open: plTypes[stateChar].open,
          close: plTypes[stateChar].close
        });
        // negation is (?:(?!js)[^/]*)
        re += stateChar === '!' ? '(?:(?!(?:' : '(?:';
        this.debug('plType %j %j', stateChar, re);
        stateChar = false;
      continue

      case ')':
        if (inClass || !patternListStack.length) {
          re += '\\)';
          continue
        }

        clearStateChar();
        hasMagic = true;
        var pl = patternListStack.pop();
        // negation is (?:(?!js)[^/]*)
        // The others are (?:<pattern>)<type>
        re += pl.close;
        if (pl.type === '!') {
          negativeLists.push(pl);
        }
        pl.reEnd = re.length;
      continue

      case '|':
        if (inClass || !patternListStack.length || escaping) {
          re += '\\|';
          escaping = false;
          continue
        }

        clearStateChar();
        re += '|';
      continue

      // these are mostly the same in regexp and glob
      case '[':
        // swallow any state-tracking char before the [
        clearStateChar();

        if (inClass) {
          re += '\\' + c;
          continue
        }

        inClass = true;
        classStart = i;
        reClassStart = re.length;
        re += c;
      continue

      case ']':
        //  a right bracket shall lose its special
        //  meaning and represent itself in
        //  a bracket expression if it occurs
        //  first in the list.  -- POSIX.2 2.8.3.2
        if (i === classStart + 1 || !inClass) {
          re += '\\' + c;
          escaping = false;
          continue
        }

        // handle the case where we left a class open.
        // "[z-a]" is valid, equivalent to "\[z-a\]"
        if (inClass) {
          // split where the last [ was, make sure we don't have
          // an invalid re. if so, re-walk the contents of the
          // would-be class to re-translate any characters that
          // were passed through as-is
          // TODO: It would probably be faster to determine this
          // without a try/catch and a new RegExp, but it's tricky
          // to do safely.  For now, this is safe and works.
          var cs = pattern.substring(classStart + 1, i);
          try {
            RegExp('[' + cs + ']');
          } catch (er) {
            // not a valid class!
            var sp = this.parse(cs, SUBPARSE);
            re = re.substr(0, reClassStart) + '\\[' + sp[0] + '\\]';
            hasMagic = hasMagic || sp[1];
            inClass = false;
            continue
          }
        }

        // finish up the class.
        hasMagic = true;
        inClass = false;
        re += c;
      continue

      default:
        // swallow any state char that wasn't consumed
        clearStateChar();

        if (escaping) {
          // no need
          escaping = false;
        } else if (reSpecials[c]
          && !(c === '^' && inClass)) {
          re += '\\';
        }

        re += c;

    } // switch
  } // for

  // handle the case where we left a class open.
  // "[abc" is valid, equivalent to "\[abc"
  if (inClass) {
    // split where the last [ was, and escape it
    // this is a huge pita.  We now have to re-walk
    // the contents of the would-be class to re-translate
    // any characters that were passed through as-is
    cs = pattern.substr(classStart + 1);
    sp = this.parse(cs, SUBPARSE);
    re = re.substr(0, reClassStart) + '\\[' + sp[0];
    hasMagic = hasMagic || sp[1];
  }

  // handle the case where we had a +( thing at the *end*
  // of the pattern.
  // each pattern list stack adds 3 chars, and we need to go through
  // and escape any | chars that were passed through as-is for the regexp.
  // Go through and escape them, taking care not to double-escape any
  // | chars that were already escaped.
  for (pl = patternListStack.pop(); pl; pl = patternListStack.pop()) {
    var tail = re.slice(pl.reStart + pl.open.length);
    this.debug('setting tail', re, pl);
    // maybe some even number of \, then maybe 1 \, followed by a |
    tail = tail.replace(/((?:\\{2}){0,64})(\\?)\|/g, function (_, $1, $2) {
      if (!$2) {
        // the | isn't already escaped, so escape it.
        $2 = '\\';
      }

      // need to escape all those slashes *again*, without escaping the
      // one that we need for escaping the | character.  As it works out,
      // escaping an even number of slashes can be done by simply repeating
      // it exactly after itself.  That's why this trick works.
      //
      // I am sorry that you have to see this.
      return $1 + $1 + $2 + '|'
    });

    this.debug('tail=%j\n   %s', tail, tail, pl, re);
    var t = pl.type === '*' ? star
      : pl.type === '?' ? qmark
      : '\\' + pl.type;

    hasMagic = true;
    re = re.slice(0, pl.reStart) + t + '\\(' + tail;
  }

  // handle trailing things that only matter at the very end.
  clearStateChar();
  if (escaping) {
    // trailing \\
    re += '\\\\';
  }

  // only need to apply the nodot start if the re starts with
  // something that could conceivably capture a dot
  var addPatternStart = false;
  switch (re.charAt(0)) {
    case '.':
    case '[':
    case '(': addPatternStart = true;
  }

  // Hack to work around lack of negative lookbehind in JS
  // A pattern like: *.!(x).!(y|z) needs to ensure that a name
  // like 'a.xyz.yz' doesn't match.  So, the first negative
  // lookahead, has to look ALL the way ahead, to the end of
  // the pattern.
  for (var n = negativeLists.length - 1; n > -1; n--) {
    var nl = negativeLists[n];

    var nlBefore = re.slice(0, nl.reStart);
    var nlFirst = re.slice(nl.reStart, nl.reEnd - 8);
    var nlLast = re.slice(nl.reEnd - 8, nl.reEnd);
    var nlAfter = re.slice(nl.reEnd);

    nlLast += nlAfter;

    // Handle nested stuff like *(*.js|!(*.json)), where open parens
    // mean that we should *not* include the ) in the bit that is considered
    // "after" the negated section.
    var openParensBefore = nlBefore.split('(').length - 1;
    var cleanAfter = nlAfter;
    for (i = 0; i < openParensBefore; i++) {
      cleanAfter = cleanAfter.replace(/\)[+*?]?/, '');
    }
    nlAfter = cleanAfter;

    var dollar = '';
    if (nlAfter === '' && isSub !== SUBPARSE) {
      dollar = '$';
    }
    var newRe = nlBefore + nlFirst + nlAfter + dollar + nlLast;
    re = newRe;
  }

  // if the re is not "" at this point, then we need to make sure
  // it doesn't match against an empty path part.
  // Otherwise a/* will match a/, which it should not.
  if (re !== '' && hasMagic) {
    re = '(?=.)' + re;
  }

  if (addPatternStart) {
    re = patternStart + re;
  }

  // parsing just a piece of a larger pattern.
  if (isSub === SUBPARSE) {
    return [re, hasMagic]
  }

  // skip the regexp for non-magical patterns
  // unescape anything in it, though, so that it'll be
  // an exact match against a file etc.
  if (!hasMagic) {
    return globUnescape(pattern)
  }

  var flags = options.nocase ? 'i' : '';
  try {
    var regExp = new RegExp('^' + re + '$', flags);
  } catch (er) {
    // If it was an invalid regular expression, then it can't match
    // anything.  This trick looks for a character after the end of
    // the string, which is of course impossible, except in multi-line
    // mode, but it's not a /m regex.
    return new RegExp('$.')
  }

  regExp._glob = pattern;
  regExp._src = re;

  return regExp
}

minimatch.makeRe = function (pattern, options) {
  return new Minimatch(pattern, options || {}).makeRe()
};

Minimatch.prototype.makeRe = makeRe;
function makeRe () {
  if (this.regexp || this.regexp === false) return this.regexp

  // at this point, this.set is a 2d array of partial
  // pattern strings, or "**".
  //
  // It's better to use .match().  This function shouldn't
  // be used, really, but it's pretty convenient sometimes,
  // when you just want to work with a regex.
  var set = this.set;

  if (!set.length) {
    this.regexp = false;
    return this.regexp
  }
  var options = this.options;

  var twoStar = options.noglobstar ? star
    : options.dot ? twoStarDot
    : twoStarNoDot;
  var flags = options.nocase ? 'i' : '';

  var re = set.map(function (pattern) {
    return pattern.map(function (p) {
      return (p === GLOBSTAR) ? twoStar
      : (typeof p === 'string') ? regExpEscape(p)
      : p._src
    }).join('\\\/')
  }).join('|');

  // must match entire pattern
  // ending in a * or ** will make it less strict.
  re = '^(?:' + re + ')$';

  // can match anything, as long as it's not this.
  if (this.negate) re = '^(?!' + re + ').*$';

  try {
    this.regexp = new RegExp(re, flags);
  } catch (ex) {
    this.regexp = false;
  }
  return this.regexp
}

minimatch.match = function (list, pattern, options) {
  options = options || {};
  var mm = new Minimatch(pattern, options);
  list = list.filter(function (f) {
    return mm.match(f)
  });
  if (mm.options.nonull && !list.length) {
    list.push(pattern);
  }
  return list
};

Minimatch.prototype.match = match;
function match (f, partial) {
  this.debug('match', f, this.pattern);
  // short-circuit in the case of busted things.
  // comments, etc.
  if (this.comment) return false
  if (this.empty) return f === ''

  if (f === '/' && partial) return true

  var options = this.options;

  // windows: need to use /, not \
  if (path.sep !== '/') {
    f = f.split(path.sep).join('/');
  }

  // treat the test path as a set of pathparts.
  f = f.split(slashSplit);
  this.debug(this.pattern, 'split', f);

  // just ONE of the pattern sets in this.set needs to match
  // in order for it to be valid.  If negating, then just one
  // match means that we have failed.
  // Either way, return on the first hit.

  var set = this.set;
  this.debug(this.pattern, 'set', set);

  // Find the basename of the path by looking for the last non-empty segment
  var filename;
  var i;
  for (i = f.length - 1; i >= 0; i--) {
    filename = f[i];
    if (filename) break
  }

  for (i = 0; i < set.length; i++) {
    var pattern = set[i];
    var file = f;
    if (options.matchBase && pattern.length === 1) {
      file = [filename];
    }
    var hit = this.matchOne(file, pattern, partial);
    if (hit) {
      if (options.flipNegate) return true
      return !this.negate
    }
  }

  // didn't get any hits.  this is success if it's a negative
  // pattern, failure otherwise.
  if (options.flipNegate) return false
  return this.negate
}

// set partial to true to test if, for example,
// "/a/b" matches the start of "/*/b/*/d"
// Partial means, if you run out of file before you run
// out of pattern, then that's fine, as long as all
// the parts match.
Minimatch.prototype.matchOne = function (file, pattern, partial) {
  var options = this.options;

  this.debug('matchOne',
    { 'this': this, file: file, pattern: pattern });

  this.debug('matchOne', file.length, pattern.length);

  for (var fi = 0,
      pi = 0,
      fl = file.length,
      pl = pattern.length
      ; (fi < fl) && (pi < pl)
      ; fi++, pi++) {
    this.debug('matchOne loop');
    var p = pattern[pi];
    var f = file[fi];

    this.debug(pattern, p, f);

    // should be impossible.
    // some invalid regexp stuff in the set.
    if (p === false) return false

    if (p === GLOBSTAR) {
      this.debug('GLOBSTAR', [pattern, p, f]);

      // "**"
      // a/**/b/**/c would match the following:
      // a/b/x/y/z/c
      // a/x/y/z/b/c
      // a/b/x/b/x/c
      // a/b/c
      // To do this, take the rest of the pattern after
      // the **, and see if it would match the file remainder.
      // If so, return success.
      // If not, the ** "swallows" a segment, and try again.
      // This is recursively awful.
      //
      // a/**/b/**/c matching a/b/x/y/z/c
      // - a matches a
      // - doublestar
      //   - matchOne(b/x/y/z/c, b/**/c)
      //     - b matches b
      //     - doublestar
      //       - matchOne(x/y/z/c, c) -> no
      //       - matchOne(y/z/c, c) -> no
      //       - matchOne(z/c, c) -> no
      //       - matchOne(c, c) yes, hit
      var fr = fi;
      var pr = pi + 1;
      if (pr === pl) {
        this.debug('** at the end');
        // a ** at the end will just swallow the rest.
        // We have found a match.
        // however, it will not swallow /.x, unless
        // options.dot is set.
        // . and .. are *never* matched by **, for explosively
        // exponential reasons.
        for (; fi < fl; fi++) {
          if (file[fi] === '.' || file[fi] === '..' ||
            (!options.dot && file[fi].charAt(0) === '.')) return false
        }
        return true
      }

      // ok, let's see if we can swallow whatever we can.
      while (fr < fl) {
        var swallowee = file[fr];

        this.debug('\nglobstar while', file, fr, pattern, pr, swallowee);

        // XXX remove this slice.  Just pass the start index.
        if (this.matchOne(file.slice(fr), pattern.slice(pr), partial)) {
          this.debug('globstar found match!', fr, fl, swallowee);
          // found a match.
          return true
        } else {
          // can't swallow "." or ".." ever.
          // can only swallow ".foo" when explicitly asked.
          if (swallowee === '.' || swallowee === '..' ||
            (!options.dot && swallowee.charAt(0) === '.')) {
            this.debug('dot detected!', file, fr, pattern, pr);
            break
          }

          // ** swallows a segment, and continue.
          this.debug('globstar swallow a segment, and continue');
          fr++;
        }
      }

      // no match was found.
      // However, in partial mode, we can't say this is necessarily over.
      // If there's more *pattern* left, then
      if (partial) {
        // ran out of file
        this.debug('\n>>> no match, partial?', file, fr, pattern, pr);
        if (fr === fl) return true
      }
      return false
    }

    // something other than **
    // non-magic patterns just have to match exactly
    // patterns with magic have been turned into regexps.
    var hit;
    if (typeof p === 'string') {
      if (options.nocase) {
        hit = f.toLowerCase() === p.toLowerCase();
      } else {
        hit = f === p;
      }
      this.debug('string match', p, f, hit);
    } else {
      hit = f.match(p);
      this.debug('pattern match', p, f, hit);
    }

    if (!hit) return false
  }

  // Note: ending in / means that we'll get a final ""
  // at the end of the pattern.  This can only match a
  // corresponding "" at the end of the file.
  // If the file ends in /, then it can only match a
  // a pattern that ends in /, unless the pattern just
  // doesn't have any more for it. But, a/b/ should *not*
  // match "a/b/*", even though "" matches against the
  // [^/]*? pattern, except in partial mode, where it might
  // simply not be reached yet.
  // However, a/b/ should still satisfy a/*

  // now either we fell off the end of the pattern, or we're done.
  if (fi === fl && pi === pl) {
    // ran out of pattern and filename at the same time.
    // an exact hit!
    return true
  } else if (fi === fl) {
    // ran out of file, but still had pattern left.
    // this is ok if we're doing the match as part of
    // a glob fs traversal.
    return partial
  } else if (pi === pl) {
    // ran out of pattern, still have file left.
    // this is only acceptable if we're on the very last
    // empty segment of a file with a trailing slash.
    // a/* should match a/b/
    var emptyFileEnd = (fi === fl - 1) && (file[fi] === '');
    return emptyFileEnd
  }

  // should be unreachable.
  throw new Error('wtf?')
};

// replace stuff like \* with *
function globUnescape (s) {
  return s.replace(/\\(.)/g, '$1')
}

function regExpEscape (s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

var inherits_browser = createCommonjsModule(function (module) {
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor;
    var TempCtor = function () {};
    TempCtor.prototype = superCtor.prototype;
    ctor.prototype = new TempCtor();
    ctor.prototype.constructor = ctor;
  };
}
});

function posix(path) {
	return path.charAt(0) === '/';
}

function win32(path) {
	// https://github.com/nodejs/node/blob/b3fcc245fb25539909ef1d5eaa01dbf92e168633/lib/path.js#L56
	var splitDeviceRe = /^([a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/]+[^\\\/]+)?([\\\/])?([\s\S]*?)$/;
	var result = splitDeviceRe.exec(path);
	var device = result[1] || '';
	var isUnc = Boolean(device && device.charAt(1) !== ':');

	// UNC paths are always absolute
	return Boolean(result[2] || isUnc);
}

var pathIsAbsolute = process.platform === 'win32' ? win32 : posix;
var posix_1 = posix;
var win32_1 = win32;
pathIsAbsolute.posix = posix_1;
pathIsAbsolute.win32 = win32_1;

var alphasort_1 = alphasort;
var alphasorti_1 = alphasorti;
var setopts_1 = setopts;
var ownProp_1 = ownProp;
var makeAbs_1 = makeAbs;
var finish_1 = finish;
var mark_1 = mark;
var isIgnored_1 = isIgnored;
var childrenIgnored_1 = childrenIgnored;

function ownProp (obj, field) {
  return Object.prototype.hasOwnProperty.call(obj, field)
}




var Minimatch$1 = minimatch_1.Minimatch;

function alphasorti (a, b) {
  return a.toLowerCase().localeCompare(b.toLowerCase())
}

function alphasort (a, b) {
  return a.localeCompare(b)
}

function setupIgnores (self, options) {
  self.ignore = options.ignore || [];

  if (!Array.isArray(self.ignore))
    self.ignore = [self.ignore];

  if (self.ignore.length) {
    self.ignore = self.ignore.map(ignoreMap);
  }
}

// ignore patterns are always in dot:true mode.
function ignoreMap (pattern) {
  var gmatcher = null;
  if (pattern.slice(-3) === '/**') {
    var gpattern = pattern.replace(/(\/\*\*)+$/, '');
    gmatcher = new Minimatch$1(gpattern, { dot: true });
  }

  return {
    matcher: new Minimatch$1(pattern, { dot: true }),
    gmatcher: gmatcher
  }
}

function setopts (self, pattern, options) {
  if (!options)
    options = {};

  // base-matching: just use globstar for that.
  if (options.matchBase && -1 === pattern.indexOf("/")) {
    if (options.noglobstar) {
      throw new Error("base matching requires globstar")
    }
    pattern = "**/" + pattern;
  }

  self.silent = !!options.silent;
  self.pattern = pattern;
  self.strict = options.strict !== false;
  self.realpath = !!options.realpath;
  self.realpathCache = options.realpathCache || Object.create(null);
  self.follow = !!options.follow;
  self.dot = !!options.dot;
  self.mark = !!options.mark;
  self.nodir = !!options.nodir;
  if (self.nodir)
    self.mark = true;
  self.sync = !!options.sync;
  self.nounique = !!options.nounique;
  self.nonull = !!options.nonull;
  self.nosort = !!options.nosort;
  self.nocase = !!options.nocase;
  self.stat = !!options.stat;
  self.noprocess = !!options.noprocess;
  self.absolute = !!options.absolute;

  self.maxLength = options.maxLength || Infinity;
  self.cache = options.cache || Object.create(null);
  self.statCache = options.statCache || Object.create(null);
  self.symlinks = options.symlinks || Object.create(null);

  setupIgnores(self, options);

  self.changedCwd = false;
  var cwd = process.cwd();
  if (!ownProp(options, "cwd"))
    self.cwd = cwd;
  else {
    self.cwd = path$1.resolve(options.cwd);
    self.changedCwd = self.cwd !== cwd;
  }

  self.root = options.root || path$1.resolve(self.cwd, "/");
  self.root = path$1.resolve(self.root);
  if (process.platform === "win32")
    self.root = self.root.replace(/\\/g, "/");

  // TODO: is an absolute `cwd` supposed to be resolved against `root`?
  // e.g. { cwd: '/test', root: __dirname } === path.join(__dirname, '/test')
  self.cwdAbs = pathIsAbsolute(self.cwd) ? self.cwd : makeAbs(self, self.cwd);
  if (process.platform === "win32")
    self.cwdAbs = self.cwdAbs.replace(/\\/g, "/");
  self.nomount = !!options.nomount;

  // disable comments and negation in Minimatch.
  // Note that they are not supported in Glob itself anyway.
  options.nonegate = true;
  options.nocomment = true;

  self.minimatch = new Minimatch$1(pattern, options);
  self.options = self.minimatch.options;
}

function finish (self) {
  var nou = self.nounique;
  var all = nou ? [] : Object.create(null);

  for (var i = 0, l = self.matches.length; i < l; i ++) {
    var matches = self.matches[i];
    if (!matches || Object.keys(matches).length === 0) {
      if (self.nonull) {
        // do like the shell, and spit out the literal glob
        var literal = self.minimatch.globSet[i];
        if (nou)
          all.push(literal);
        else
          all[literal] = true;
      }
    } else {
      // had matches
      var m = Object.keys(matches);
      if (nou)
        all.push.apply(all, m);
      else
        m.forEach(function (m) {
          all[m] = true;
        });
    }
  }

  if (!nou)
    all = Object.keys(all);

  if (!self.nosort)
    all = all.sort(self.nocase ? alphasorti : alphasort);

  // at *some* point we statted all of these
  if (self.mark) {
    for (var i = 0; i < all.length; i++) {
      all[i] = self._mark(all[i]);
    }
    if (self.nodir) {
      all = all.filter(function (e) {
        var notDir = !(/\/$/.test(e));
        var c = self.cache[e] || self.cache[makeAbs(self, e)];
        if (notDir && c)
          notDir = c !== 'DIR' && !Array.isArray(c);
        return notDir
      });
    }
  }

  if (self.ignore.length)
    all = all.filter(function(m) {
      return !isIgnored(self, m)
    });

  self.found = all;
}

function mark (self, p) {
  var abs = makeAbs(self, p);
  var c = self.cache[abs];
  var m = p;
  if (c) {
    var isDir = c === 'DIR' || Array.isArray(c);
    var slash = p.slice(-1) === '/';

    if (isDir && !slash)
      m += '/';
    else if (!isDir && slash)
      m = m.slice(0, -1);

    if (m !== p) {
      var mabs = makeAbs(self, m);
      self.statCache[mabs] = self.statCache[abs];
      self.cache[mabs] = self.cache[abs];
    }
  }

  return m
}

// lotta situps...
function makeAbs (self, f) {
  var abs = f;
  if (f.charAt(0) === '/') {
    abs = path$1.join(self.root, f);
  } else if (pathIsAbsolute(f) || f === '') {
    abs = f;
  } else if (self.changedCwd) {
    abs = path$1.resolve(self.cwd, f);
  } else {
    abs = path$1.resolve(f);
  }

  if (process.platform === 'win32')
    abs = abs.replace(/\\/g, '/');

  return abs
}


// Return true, if pattern ends with globstar '**', for the accompanying parent directory.
// Ex:- If node_modules/** is the pattern, add 'node_modules' to ignore list along with it's contents
function isIgnored (self, path) {
  if (!self.ignore.length)
    return false

  return self.ignore.some(function(item) {
    return item.matcher.match(path) || !!(item.gmatcher && item.gmatcher.match(path))
  })
}

function childrenIgnored (self, path) {
  if (!self.ignore.length)
    return false

  return self.ignore.some(function(item) {
    return !!(item.gmatcher && item.gmatcher.match(path))
  })
}

var common = {
	alphasort: alphasort_1,
	alphasorti: alphasorti_1,
	setopts: setopts_1,
	ownProp: ownProp_1,
	makeAbs: makeAbs_1,
	finish: finish_1,
	mark: mark_1,
	isIgnored: isIgnored_1,
	childrenIgnored: childrenIgnored_1
};

var sync = globSync;
globSync.GlobSync = GlobSync;
var setopts$1 = common.setopts;
var ownProp$1 = common.ownProp;
var childrenIgnored$1 = common.childrenIgnored;
var isIgnored$1 = common.isIgnored;

function globSync (pattern, options) {
  if (typeof options === 'function' || arguments.length === 3)
    throw new TypeError('callback provided to sync glob\n'+
                        'See: https://github.com/isaacs/node-glob/issues/167')

  return new GlobSync(pattern, options).found
}

function GlobSync (pattern, options) {
  if (!pattern)
    throw new Error('must provide pattern')

  if (typeof options === 'function' || arguments.length === 3)
    throw new TypeError('callback provided to sync glob\n'+
                        'See: https://github.com/isaacs/node-glob/issues/167')

  if (!(this instanceof GlobSync))
    return new GlobSync(pattern, options)

  setopts$1(this, pattern, options);

  if (this.noprocess)
    return this

  var n = this.minimatch.set.length;
  this.matches = new Array(n);
  for (var i = 0; i < n; i ++) {
    this._process(this.minimatch.set[i], i, false);
  }
  this._finish();
}

GlobSync.prototype._finish = function () {
  assert(this instanceof GlobSync);
  if (this.realpath) {
    var self = this;
    this.matches.forEach(function (matchset, index) {
      var set = self.matches[index] = Object.create(null);
      for (var p in matchset) {
        try {
          p = self._makeAbs(p);
          var real = fs_realpath.realpathSync(p, self.realpathCache);
          set[real] = true;
        } catch (er) {
          if (er.syscall === 'stat')
            set[self._makeAbs(p)] = true;
          else
            throw er
        }
      }
    });
  }
  common.finish(this);
};


GlobSync.prototype._process = function (pattern, index, inGlobStar) {
  assert(this instanceof GlobSync);

  // Get the first [n] parts of pattern that are all strings.
  var n = 0;
  while (typeof pattern[n] === 'string') {
    n ++;
  }
  // now n is the index of the first one that is *not* a string.

  // See if there's anything else
  var prefix;
  switch (n) {
    // if not, then this is rather simple
    case pattern.length:
      this._processSimple(pattern.join('/'), index);
      return

    case 0:
      // pattern *starts* with some non-trivial item.
      // going to readdir(cwd), but not include the prefix in matches.
      prefix = null;
      break

    default:
      // pattern has some string bits in the front.
      // whatever it starts with, whether that's 'absolute' like /foo/bar,
      // or 'relative' like '../baz'
      prefix = pattern.slice(0, n).join('/');
      break
  }

  var remain = pattern.slice(n);

  // get the list of entries.
  var read;
  if (prefix === null)
    read = '.';
  else if (pathIsAbsolute(prefix) || pathIsAbsolute(pattern.join('/'))) {
    if (!prefix || !pathIsAbsolute(prefix))
      prefix = '/' + prefix;
    read = prefix;
  } else
    read = prefix;

  var abs = this._makeAbs(read);

  //if ignored, skip processing
  if (childrenIgnored$1(this, read))
    return

  var isGlobStar = remain[0] === minimatch_1.GLOBSTAR;
  if (isGlobStar)
    this._processGlobStar(prefix, read, abs, remain, index, inGlobStar);
  else
    this._processReaddir(prefix, read, abs, remain, index, inGlobStar);
};


GlobSync.prototype._processReaddir = function (prefix, read, abs, remain, index, inGlobStar) {
  var entries = this._readdir(abs, inGlobStar);

  // if the abs isn't a dir, then nothing can match!
  if (!entries)
    return

  // It will only match dot entries if it starts with a dot, or if
  // dot is set.  Stuff like @(.foo|.bar) isn't allowed.
  var pn = remain[0];
  var negate = !!this.minimatch.negate;
  var rawGlob = pn._glob;
  var dotOk = this.dot || rawGlob.charAt(0) === '.';

  var matchedEntries = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.charAt(0) !== '.' || dotOk) {
      var m;
      if (negate && !prefix) {
        m = !e.match(pn);
      } else {
        m = e.match(pn);
      }
      if (m)
        matchedEntries.push(e);
    }
  }

  var len = matchedEntries.length;
  // If there are no matched entries, then nothing matches.
  if (len === 0)
    return

  // if this is the last remaining pattern bit, then no need for
  // an additional stat *unless* the user has specified mark or
  // stat explicitly.  We know they exist, since readdir returned
  // them.

  if (remain.length === 1 && !this.mark && !this.stat) {
    if (!this.matches[index])
      this.matches[index] = Object.create(null);

    for (var i = 0; i < len; i ++) {
      var e = matchedEntries[i];
      if (prefix) {
        if (prefix.slice(-1) !== '/')
          e = prefix + '/' + e;
        else
          e = prefix + e;
      }

      if (e.charAt(0) === '/' && !this.nomount) {
        e = path$1.join(this.root, e);
      }
      this._emitMatch(index, e);
    }
    // This was the last one, and no stats were needed
    return
  }

  // now test all matched entries as stand-ins for that part
  // of the pattern.
  remain.shift();
  for (var i = 0; i < len; i ++) {
    var e = matchedEntries[i];
    var newPattern;
    if (prefix)
      newPattern = [prefix, e];
    else
      newPattern = [e];
    this._process(newPattern.concat(remain), index, inGlobStar);
  }
};


GlobSync.prototype._emitMatch = function (index, e) {
  if (isIgnored$1(this, e))
    return

  var abs = this._makeAbs(e);

  if (this.mark)
    e = this._mark(e);

  if (this.absolute) {
    e = abs;
  }

  if (this.matches[index][e])
    return

  if (this.nodir) {
    var c = this.cache[abs];
    if (c === 'DIR' || Array.isArray(c))
      return
  }

  this.matches[index][e] = true;

  if (this.stat)
    this._stat(e);
};


GlobSync.prototype._readdirInGlobStar = function (abs) {
  // follow all symlinked directories forever
  // just proceed as if this is a non-globstar situation
  if (this.follow)
    return this._readdir(abs, false)

  var entries;
  var lstat;
  try {
    lstat = fs$2.lstatSync(abs);
  } catch (er) {
    if (er.code === 'ENOENT') {
      // lstat failed, doesn't exist
      return null
    }
  }

  var isSym = lstat && lstat.isSymbolicLink();
  this.symlinks[abs] = isSym;

  // If it's not a symlink or a dir, then it's definitely a regular file.
  // don't bother doing a readdir in that case.
  if (!isSym && lstat && !lstat.isDirectory())
    this.cache[abs] = 'FILE';
  else
    entries = this._readdir(abs, false);

  return entries
};

GlobSync.prototype._readdir = function (abs, inGlobStar) {

  if (inGlobStar && !ownProp$1(this.symlinks, abs))
    return this._readdirInGlobStar(abs)

  if (ownProp$1(this.cache, abs)) {
    var c = this.cache[abs];
    if (!c || c === 'FILE')
      return null

    if (Array.isArray(c))
      return c
  }

  try {
    return this._readdirEntries(abs, fs$2.readdirSync(abs))
  } catch (er) {
    this._readdirError(abs, er);
    return null
  }
};

GlobSync.prototype._readdirEntries = function (abs, entries) {
  // if we haven't asked to stat everything, then just
  // assume that everything in there exists, so we can avoid
  // having to stat it a second time.
  if (!this.mark && !this.stat) {
    for (var i = 0; i < entries.length; i ++) {
      var e = entries[i];
      if (abs === '/')
        e = abs + e;
      else
        e = abs + '/' + e;
      this.cache[e] = true;
    }
  }

  this.cache[abs] = entries;

  // mark and cache dir-ness
  return entries
};

GlobSync.prototype._readdirError = function (f, er) {
  // handle errors, and cache the information
  switch (er.code) {
    case 'ENOTSUP': // https://github.com/isaacs/node-glob/issues/205
    case 'ENOTDIR': // totally normal. means it *does* exist.
      var abs = this._makeAbs(f);
      this.cache[abs] = 'FILE';
      if (abs === this.cwdAbs) {
        var error = new Error(er.code + ' invalid cwd ' + this.cwd);
        error.path = this.cwd;
        error.code = er.code;
        throw error
      }
      break

    case 'ENOENT': // not terribly unusual
    case 'ELOOP':
    case 'ENAMETOOLONG':
    case 'UNKNOWN':
      this.cache[this._makeAbs(f)] = false;
      break

    default: // some unusual error.  Treat as failure.
      this.cache[this._makeAbs(f)] = false;
      if (this.strict)
        throw er
      if (!this.silent)
        console.error('glob error', er);
      break
  }
};

GlobSync.prototype._processGlobStar = function (prefix, read, abs, remain, index, inGlobStar) {

  var entries = this._readdir(abs, inGlobStar);

  // no entries means not a dir, so it can never have matches
  // foo.txt/** doesn't match foo.txt
  if (!entries)
    return

  // test without the globstar, and with every child both below
  // and replacing the globstar.
  var remainWithoutGlobStar = remain.slice(1);
  var gspref = prefix ? [ prefix ] : [];
  var noGlobStar = gspref.concat(remainWithoutGlobStar);

  // the noGlobStar pattern exits the inGlobStar state
  this._process(noGlobStar, index, false);

  var len = entries.length;
  var isSym = this.symlinks[abs];

  // If it's a symlink, and we're in a globstar, then stop
  if (isSym && inGlobStar)
    return

  for (var i = 0; i < len; i++) {
    var e = entries[i];
    if (e.charAt(0) === '.' && !this.dot)
      continue

    // these two cases enter the inGlobStar state
    var instead = gspref.concat(entries[i], remainWithoutGlobStar);
    this._process(instead, index, true);

    var below = gspref.concat(entries[i], remain);
    this._process(below, index, true);
  }
};

GlobSync.prototype._processSimple = function (prefix, index) {
  // XXX review this.  Shouldn't it be doing the mounting etc
  // before doing stat?  kinda weird?
  var exists = this._stat(prefix);

  if (!this.matches[index])
    this.matches[index] = Object.create(null);

  // If it doesn't exist, then just mark the lack of results
  if (!exists)
    return

  if (prefix && pathIsAbsolute(prefix) && !this.nomount) {
    var trail = /[\/\\]$/.test(prefix);
    if (prefix.charAt(0) === '/') {
      prefix = path$1.join(this.root, prefix);
    } else {
      prefix = path$1.resolve(this.root, prefix);
      if (trail)
        prefix += '/';
    }
  }

  if (process.platform === 'win32')
    prefix = prefix.replace(/\\/g, '/');

  // Mark this as a match
  this._emitMatch(index, prefix);
};

// Returns either 'DIR', 'FILE', or false
GlobSync.prototype._stat = function (f) {
  var abs = this._makeAbs(f);
  var needDir = f.slice(-1) === '/';

  if (f.length > this.maxLength)
    return false

  if (!this.stat && ownProp$1(this.cache, abs)) {
    var c = this.cache[abs];

    if (Array.isArray(c))
      c = 'DIR';

    // It exists, but maybe not how we need it
    if (!needDir || c === 'DIR')
      return c

    if (needDir && c === 'FILE')
      return false

    // otherwise we have to stat, because maybe c=true
    // if we know it exists, but not what it is.
  }
  var stat = this.statCache[abs];
  if (!stat) {
    var lstat;
    try {
      lstat = fs$2.lstatSync(abs);
    } catch (er) {
      if (er && (er.code === 'ENOENT' || er.code === 'ENOTDIR')) {
        this.statCache[abs] = false;
        return false
      }
    }

    if (lstat && lstat.isSymbolicLink()) {
      try {
        stat = fs$2.statSync(abs);
      } catch (er) {
        stat = lstat;
      }
    } else {
      stat = lstat;
    }
  }

  this.statCache[abs] = stat;

  var c = true;
  if (stat)
    c = stat.isDirectory() ? 'DIR' : 'FILE';

  this.cache[abs] = this.cache[abs] || c;

  if (needDir && c === 'FILE')
    return false

  return c
};

GlobSync.prototype._mark = function (p) {
  return common.mark(this, p)
};

GlobSync.prototype._makeAbs = function (f) {
  return common.makeAbs(this, f)
};

// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
var wrappy_1 = wrappy;
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k];
  });

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }
    var ret = fn.apply(this, args);
    var cb = args[args.length-1];
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k];
      });
    }
    return ret
  }
}

var once_1 = wrappy_1(once);
var strict = wrappy_1(onceStrict);

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  });

  Object.defineProperty(Function.prototype, 'onceStrict', {
    value: function () {
      return onceStrict(this)
    },
    configurable: true
  });
});

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true;
    return f.value = fn.apply(this, arguments)
  };
  f.called = false;
  return f
}

function onceStrict (fn) {
  var f = function () {
    if (f.called)
      throw new Error(f.onceError)
    f.called = true;
    return f.value = fn.apply(this, arguments)
  };
  var name = fn.name || 'Function wrapped with `once`';
  f.onceError = name + " shouldn't be called more than once";
  f.called = false;
  return f
}
once_1.strict = strict;

var reqs = Object.create(null);


var inflight_1 = wrappy_1(inflight);

function inflight (key, cb) {
  if (reqs[key]) {
    reqs[key].push(cb);
    return null
  } else {
    reqs[key] = [cb];
    return makeres(key)
  }
}

function makeres (key) {
  return once_1(function RES () {
    var cbs = reqs[key];
    var len = cbs.length;
    var args = slice(arguments);

    // XXX It's somewhat ambiguous whether a new callback added in this
    // pass should be queued for later execution if something in the
    // list of callbacks throws, or if it should just be discarded.
    // However, it's such an edge case that it hardly matters, and either
    // choice is likely as surprising as the other.
    // As it happens, we do go ahead and schedule it for later execution.
    try {
      for (var i = 0; i < len; i++) {
        cbs[i].apply(null, args);
      }
    } finally {
      if (cbs.length > len) {
        // added more in the interim.
        // de-zalgo, just in case, but don't call again.
        cbs.splice(0, len);
        process.nextTick(function () {
          RES.apply(null, args);
        });
      } else {
        delete reqs[key];
      }
    }
  })
}

function slice (args) {
  var length = args.length;
  var array = [];

  for (var i = 0; i < length; i++) array[i] = args[i];
  return array
}

// Approach:
//
// 1. Get the minimatch set
// 2. For each pattern in the set, PROCESS(pattern, false)
// 3. Store matches per-set, then uniq them
//
// PROCESS(pattern, inGlobStar)
// Get the first [n] items from pattern that are all strings
// Join these together.  This is PREFIX.
//   If there is no more remaining, then stat(PREFIX) and
//   add to matches if it succeeds.  END.
//
// If inGlobStar and PREFIX is symlink and points to dir
//   set ENTRIES = []
// else readdir(PREFIX) as ENTRIES
//   If fail, END
//
// with ENTRIES
//   If pattern[n] is GLOBSTAR
//     // handle the case where the globstar match is empty
//     // by pruning it out, and testing the resulting pattern
//     PROCESS(pattern[0..n] + pattern[n+1 .. $], false)
//     // handle other cases.
//     for ENTRY in ENTRIES (not dotfiles)
//       // attach globstar + tail onto the entry
//       // Mark that this entry is a globstar match
//       PROCESS(pattern[0..n] + ENTRY + pattern[n .. $], true)
//
//   else // not globstar
//     for ENTRY in ENTRIES (not dotfiles, unless pattern[n] is dot)
//       Test ENTRY against pattern[n]
//       If fails, continue
//       If passes, PROCESS(pattern[0..n] + item + pattern[n+1 .. $])
//
// Caveat:
//   Cache all stats and readdirs results to minimize syscall.  Since all
//   we ever care about is existence and directory-ness, we can just keep
//   `true` for files, and [children,...] for directories, or `false` for
//   things that don't exist.

var glob_1 = glob;

var EE = events.EventEmitter;
var setopts$2 = common.setopts;
var ownProp$2 = common.ownProp;


var childrenIgnored$2 = common.childrenIgnored;
var isIgnored$2 = common.isIgnored;



function glob (pattern, options, cb) {
  if (typeof options === 'function') cb = options, options = {};
  if (!options) options = {};

  if (options.sync) {
    if (cb)
      throw new TypeError('callback provided to sync glob')
    return sync(pattern, options)
  }

  return new Glob(pattern, options, cb)
}

glob.sync = sync;
var GlobSync$1 = glob.GlobSync = sync.GlobSync;

// old api surface
glob.glob = glob;

function extend (origin, add) {
  if (add === null || typeof add !== 'object') {
    return origin
  }

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin
}

glob.hasMagic = function (pattern, options_) {
  var options = extend({}, options_);
  options.noprocess = true;

  var g = new Glob(pattern, options);
  var set = g.minimatch.set;

  if (!pattern)
    return false

  if (set.length > 1)
    return true

  for (var j = 0; j < set[0].length; j++) {
    if (typeof set[0][j] !== 'string')
      return true
  }

  return false
};

glob.Glob = Glob;
inherits_browser(Glob, EE);
function Glob (pattern, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = null;
  }

  if (options && options.sync) {
    if (cb)
      throw new TypeError('callback provided to sync glob')
    return new GlobSync$1(pattern, options)
  }

  if (!(this instanceof Glob))
    return new Glob(pattern, options, cb)

  setopts$2(this, pattern, options);
  this._didRealPath = false;

  // process each pattern in the minimatch set
  var n = this.minimatch.set.length;

  // The matches are stored as {<filename>: true,...} so that
  // duplicates are automagically pruned.
  // Later, we do an Object.keys() on these.
  // Keep them as a list so we can fill in when nonull is set.
  this.matches = new Array(n);

  if (typeof cb === 'function') {
    cb = once_1(cb);
    this.on('error', cb);
    this.on('end', function (matches) {
      cb(null, matches);
    });
  }

  var self = this;
  this._processing = 0;

  this._emitQueue = [];
  this._processQueue = [];
  this.paused = false;

  if (this.noprocess)
    return this

  if (n === 0)
    return done()

  var sync = true;
  for (var i = 0; i < n; i ++) {
    this._process(this.minimatch.set[i], i, false, done);
  }
  sync = false;

  function done () {
    --self._processing;
    if (self._processing <= 0) {
      if (sync) {
        process.nextTick(function () {
          self._finish();
        });
      } else {
        self._finish();
      }
    }
  }
}

Glob.prototype._finish = function () {
  assert(this instanceof Glob);
  if (this.aborted)
    return

  if (this.realpath && !this._didRealpath)
    return this._realpath()

  common.finish(this);
  this.emit('end', this.found);
};

Glob.prototype._realpath = function () {
  if (this._didRealpath)
    return

  this._didRealpath = true;

  var n = this.matches.length;
  if (n === 0)
    return this._finish()

  var self = this;
  for (var i = 0; i < this.matches.length; i++)
    this._realpathSet(i, next);

  function next () {
    if (--n === 0)
      self._finish();
  }
};

Glob.prototype._realpathSet = function (index, cb) {
  var matchset = this.matches[index];
  if (!matchset)
    return cb()

  var found = Object.keys(matchset);
  var self = this;
  var n = found.length;

  if (n === 0)
    return cb()

  var set = this.matches[index] = Object.create(null);
  found.forEach(function (p, i) {
    // If there's a problem with the stat, then it means that
    // one or more of the links in the realpath couldn't be
    // resolved.  just return the abs value in that case.
    p = self._makeAbs(p);
    fs_realpath.realpath(p, self.realpathCache, function (er, real) {
      if (!er)
        set[real] = true;
      else if (er.syscall === 'stat')
        set[p] = true;
      else
        self.emit('error', er); // srsly wtf right here

      if (--n === 0) {
        self.matches[index] = set;
        cb();
      }
    });
  });
};

Glob.prototype._mark = function (p) {
  return common.mark(this, p)
};

Glob.prototype._makeAbs = function (f) {
  return common.makeAbs(this, f)
};

Glob.prototype.abort = function () {
  this.aborted = true;
  this.emit('abort');
};

Glob.prototype.pause = function () {
  if (!this.paused) {
    this.paused = true;
    this.emit('pause');
  }
};

Glob.prototype.resume = function () {
  if (this.paused) {
    this.emit('resume');
    this.paused = false;
    if (this._emitQueue.length) {
      var eq = this._emitQueue.slice(0);
      this._emitQueue.length = 0;
      for (var i = 0; i < eq.length; i ++) {
        var e = eq[i];
        this._emitMatch(e[0], e[1]);
      }
    }
    if (this._processQueue.length) {
      var pq = this._processQueue.slice(0);
      this._processQueue.length = 0;
      for (var i = 0; i < pq.length; i ++) {
        var p = pq[i];
        this._processing--;
        this._process(p[0], p[1], p[2], p[3]);
      }
    }
  }
};

Glob.prototype._process = function (pattern, index, inGlobStar, cb) {
  assert(this instanceof Glob);
  assert(typeof cb === 'function');

  if (this.aborted)
    return

  this._processing++;
  if (this.paused) {
    this._processQueue.push([pattern, index, inGlobStar, cb]);
    return
  }

  //console.error('PROCESS %d', this._processing, pattern)

  // Get the first [n] parts of pattern that are all strings.
  var n = 0;
  while (typeof pattern[n] === 'string') {
    n ++;
  }
  // now n is the index of the first one that is *not* a string.

  // see if there's anything else
  var prefix;
  switch (n) {
    // if not, then this is rather simple
    case pattern.length:
      this._processSimple(pattern.join('/'), index, cb);
      return

    case 0:
      // pattern *starts* with some non-trivial item.
      // going to readdir(cwd), but not include the prefix in matches.
      prefix = null;
      break

    default:
      // pattern has some string bits in the front.
      // whatever it starts with, whether that's 'absolute' like /foo/bar,
      // or 'relative' like '../baz'
      prefix = pattern.slice(0, n).join('/');
      break
  }

  var remain = pattern.slice(n);

  // get the list of entries.
  var read;
  if (prefix === null)
    read = '.';
  else if (pathIsAbsolute(prefix) || pathIsAbsolute(pattern.join('/'))) {
    if (!prefix || !pathIsAbsolute(prefix))
      prefix = '/' + prefix;
    read = prefix;
  } else
    read = prefix;

  var abs = this._makeAbs(read);

  //if ignored, skip _processing
  if (childrenIgnored$2(this, read))
    return cb()

  var isGlobStar = remain[0] === minimatch_1.GLOBSTAR;
  if (isGlobStar)
    this._processGlobStar(prefix, read, abs, remain, index, inGlobStar, cb);
  else
    this._processReaddir(prefix, read, abs, remain, index, inGlobStar, cb);
};

Glob.prototype._processReaddir = function (prefix, read, abs, remain, index, inGlobStar, cb) {
  var self = this;
  this._readdir(abs, inGlobStar, function (er, entries) {
    return self._processReaddir2(prefix, read, abs, remain, index, inGlobStar, entries, cb)
  });
};

Glob.prototype._processReaddir2 = function (prefix, read, abs, remain, index, inGlobStar, entries, cb) {

  // if the abs isn't a dir, then nothing can match!
  if (!entries)
    return cb()

  // It will only match dot entries if it starts with a dot, or if
  // dot is set.  Stuff like @(.foo|.bar) isn't allowed.
  var pn = remain[0];
  var negate = !!this.minimatch.negate;
  var rawGlob = pn._glob;
  var dotOk = this.dot || rawGlob.charAt(0) === '.';

  var matchedEntries = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.charAt(0) !== '.' || dotOk) {
      var m;
      if (negate && !prefix) {
        m = !e.match(pn);
      } else {
        m = e.match(pn);
      }
      if (m)
        matchedEntries.push(e);
    }
  }

  //console.error('prd2', prefix, entries, remain[0]._glob, matchedEntries)

  var len = matchedEntries.length;
  // If there are no matched entries, then nothing matches.
  if (len === 0)
    return cb()

  // if this is the last remaining pattern bit, then no need for
  // an additional stat *unless* the user has specified mark or
  // stat explicitly.  We know they exist, since readdir returned
  // them.

  if (remain.length === 1 && !this.mark && !this.stat) {
    if (!this.matches[index])
      this.matches[index] = Object.create(null);

    for (var i = 0; i < len; i ++) {
      var e = matchedEntries[i];
      if (prefix) {
        if (prefix !== '/')
          e = prefix + '/' + e;
        else
          e = prefix + e;
      }

      if (e.charAt(0) === '/' && !this.nomount) {
        e = path$1.join(this.root, e);
      }
      this._emitMatch(index, e);
    }
    // This was the last one, and no stats were needed
    return cb()
  }

  // now test all matched entries as stand-ins for that part
  // of the pattern.
  remain.shift();
  for (var i = 0; i < len; i ++) {
    var e = matchedEntries[i];
    if (prefix) {
      if (prefix !== '/')
        e = prefix + '/' + e;
      else
        e = prefix + e;
    }
    this._process([e].concat(remain), index, inGlobStar, cb);
  }
  cb();
};

Glob.prototype._emitMatch = function (index, e) {
  if (this.aborted)
    return

  if (isIgnored$2(this, e))
    return

  if (this.paused) {
    this._emitQueue.push([index, e]);
    return
  }

  var abs = pathIsAbsolute(e) ? e : this._makeAbs(e);

  if (this.mark)
    e = this._mark(e);

  if (this.absolute)
    e = abs;

  if (this.matches[index][e])
    return

  if (this.nodir) {
    var c = this.cache[abs];
    if (c === 'DIR' || Array.isArray(c))
      return
  }

  this.matches[index][e] = true;

  var st = this.statCache[abs];
  if (st)
    this.emit('stat', e, st);

  this.emit('match', e);
};

Glob.prototype._readdirInGlobStar = function (abs, cb) {
  if (this.aborted)
    return

  // follow all symlinked directories forever
  // just proceed as if this is a non-globstar situation
  if (this.follow)
    return this._readdir(abs, false, cb)

  var lstatkey = 'lstat\0' + abs;
  var self = this;
  var lstatcb = inflight_1(lstatkey, lstatcb_);

  if (lstatcb)
    fs$2.lstat(abs, lstatcb);

  function lstatcb_ (er, lstat) {
    if (er && er.code === 'ENOENT')
      return cb()

    var isSym = lstat && lstat.isSymbolicLink();
    self.symlinks[abs] = isSym;

    // If it's not a symlink or a dir, then it's definitely a regular file.
    // don't bother doing a readdir in that case.
    if (!isSym && lstat && !lstat.isDirectory()) {
      self.cache[abs] = 'FILE';
      cb();
    } else
      self._readdir(abs, false, cb);
  }
};

Glob.prototype._readdir = function (abs, inGlobStar, cb) {
  if (this.aborted)
    return

  cb = inflight_1('readdir\0'+abs+'\0'+inGlobStar, cb);
  if (!cb)
    return

  //console.error('RD %j %j', +inGlobStar, abs)
  if (inGlobStar && !ownProp$2(this.symlinks, abs))
    return this._readdirInGlobStar(abs, cb)

  if (ownProp$2(this.cache, abs)) {
    var c = this.cache[abs];
    if (!c || c === 'FILE')
      return cb()

    if (Array.isArray(c))
      return cb(null, c)
  }
  fs$2.readdir(abs, readdirCb(this, abs, cb));
};

function readdirCb (self, abs, cb) {
  return function (er, entries) {
    if (er)
      self._readdirError(abs, er, cb);
    else
      self._readdirEntries(abs, entries, cb);
  }
}

Glob.prototype._readdirEntries = function (abs, entries, cb) {
  if (this.aborted)
    return

  // if we haven't asked to stat everything, then just
  // assume that everything in there exists, so we can avoid
  // having to stat it a second time.
  if (!this.mark && !this.stat) {
    for (var i = 0; i < entries.length; i ++) {
      var e = entries[i];
      if (abs === '/')
        e = abs + e;
      else
        e = abs + '/' + e;
      this.cache[e] = true;
    }
  }

  this.cache[abs] = entries;
  return cb(null, entries)
};

Glob.prototype._readdirError = function (f, er, cb) {
  if (this.aborted)
    return

  // handle errors, and cache the information
  switch (er.code) {
    case 'ENOTSUP': // https://github.com/isaacs/node-glob/issues/205
    case 'ENOTDIR': // totally normal. means it *does* exist.
      var abs = this._makeAbs(f);
      this.cache[abs] = 'FILE';
      if (abs === this.cwdAbs) {
        var error = new Error(er.code + ' invalid cwd ' + this.cwd);
        error.path = this.cwd;
        error.code = er.code;
        this.emit('error', error);
        this.abort();
      }
      break

    case 'ENOENT': // not terribly unusual
    case 'ELOOP':
    case 'ENAMETOOLONG':
    case 'UNKNOWN':
      this.cache[this._makeAbs(f)] = false;
      break

    default: // some unusual error.  Treat as failure.
      this.cache[this._makeAbs(f)] = false;
      if (this.strict) {
        this.emit('error', er);
        // If the error is handled, then we abort
        // if not, we threw out of here
        this.abort();
      }
      if (!this.silent)
        console.error('glob error', er);
      break
  }

  return cb()
};

Glob.prototype._processGlobStar = function (prefix, read, abs, remain, index, inGlobStar, cb) {
  var self = this;
  this._readdir(abs, inGlobStar, function (er, entries) {
    self._processGlobStar2(prefix, read, abs, remain, index, inGlobStar, entries, cb);
  });
};


Glob.prototype._processGlobStar2 = function (prefix, read, abs, remain, index, inGlobStar, entries, cb) {
  //console.error('pgs2', prefix, remain[0], entries)

  // no entries means not a dir, so it can never have matches
  // foo.txt/** doesn't match foo.txt
  if (!entries)
    return cb()

  // test without the globstar, and with every child both below
  // and replacing the globstar.
  var remainWithoutGlobStar = remain.slice(1);
  var gspref = prefix ? [ prefix ] : [];
  var noGlobStar = gspref.concat(remainWithoutGlobStar);

  // the noGlobStar pattern exits the inGlobStar state
  this._process(noGlobStar, index, false, cb);

  var isSym = this.symlinks[abs];
  var len = entries.length;

  // If it's a symlink, and we're in a globstar, then stop
  if (isSym && inGlobStar)
    return cb()

  for (var i = 0; i < len; i++) {
    var e = entries[i];
    if (e.charAt(0) === '.' && !this.dot)
      continue

    // these two cases enter the inGlobStar state
    var instead = gspref.concat(entries[i], remainWithoutGlobStar);
    this._process(instead, index, true, cb);

    var below = gspref.concat(entries[i], remain);
    this._process(below, index, true, cb);
  }

  cb();
};

Glob.prototype._processSimple = function (prefix, index, cb) {
  // XXX review this.  Shouldn't it be doing the mounting etc
  // before doing stat?  kinda weird?
  var self = this;
  this._stat(prefix, function (er, exists) {
    self._processSimple2(prefix, index, er, exists, cb);
  });
};
Glob.prototype._processSimple2 = function (prefix, index, er, exists, cb) {

  //console.error('ps2', prefix, exists)

  if (!this.matches[index])
    this.matches[index] = Object.create(null);

  // If it doesn't exist, then just mark the lack of results
  if (!exists)
    return cb()

  if (prefix && pathIsAbsolute(prefix) && !this.nomount) {
    var trail = /[\/\\]$/.test(prefix);
    if (prefix.charAt(0) === '/') {
      prefix = path$1.join(this.root, prefix);
    } else {
      prefix = path$1.resolve(this.root, prefix);
      if (trail)
        prefix += '/';
    }
  }

  if (process.platform === 'win32')
    prefix = prefix.replace(/\\/g, '/');

  // Mark this as a match
  this._emitMatch(index, prefix);
  cb();
};

// Returns either 'DIR', 'FILE', or false
Glob.prototype._stat = function (f, cb) {
  var abs = this._makeAbs(f);
  var needDir = f.slice(-1) === '/';

  if (f.length > this.maxLength)
    return cb()

  if (!this.stat && ownProp$2(this.cache, abs)) {
    var c = this.cache[abs];

    if (Array.isArray(c))
      c = 'DIR';

    // It exists, but maybe not how we need it
    if (!needDir || c === 'DIR')
      return cb(null, c)

    if (needDir && c === 'FILE')
      return cb()

    // otherwise we have to stat, because maybe c=true
    // if we know it exists, but not what it is.
  }
  var stat = this.statCache[abs];
  if (stat !== undefined) {
    if (stat === false)
      return cb(null, stat)
    else {
      var type = stat.isDirectory() ? 'DIR' : 'FILE';
      if (needDir && type === 'FILE')
        return cb()
      else
        return cb(null, type, stat)
    }
  }

  var self = this;
  var statcb = inflight_1('stat\0' + abs, lstatcb_);
  if (statcb)
    fs$2.lstat(abs, statcb);

  function lstatcb_ (er, lstat) {
    if (lstat && lstat.isSymbolicLink()) {
      // If it's a symlink, then treat it as the target, unless
      // the target does not exist, then treat it as a file.
      return fs$2.stat(abs, function (er, stat) {
        if (er)
          self._stat2(f, abs, null, lstat, cb);
        else
          self._stat2(f, abs, er, stat, cb);
      })
    } else {
      self._stat2(f, abs, er, lstat, cb);
    }
  }
};

Glob.prototype._stat2 = function (f, abs, er, stat, cb) {
  if (er && (er.code === 'ENOENT' || er.code === 'ENOTDIR')) {
    this.statCache[abs] = false;
    return cb()
  }

  var needDir = f.slice(-1) === '/';
  this.statCache[abs] = stat;

  if (abs.slice(-1) === '/' && stat && !stat.isDirectory())
    return cb(null, false, stat)

  var c = true;
  if (stat)
    c = stat.isDirectory() ? 'DIR' : 'FILE';
  this.cache[abs] = this.cache[abs] || c;

  if (needDir && c === 'FILE')
    return cb()

  return cb(null, c, stat)
};

var rimraf_1 = rimraf;
rimraf.sync = rimrafSync;





var _0666 = parseInt('666', 8);

var defaultGlobOpts = {
  nosort: true,
  silent: true
};

// for EMFILE handling
var timeout = 0;

var isWindows$1 = (process.platform === "win32");

function defaults (options) {
  var methods = [
    'unlink',
    'chmod',
    'stat',
    'lstat',
    'rmdir',
    'readdir'
  ];
  methods.forEach(function(m) {
    options[m] = options[m] || fs$2[m];
    m = m + 'Sync';
    options[m] = options[m] || fs$2[m];
  });

  options.maxBusyTries = options.maxBusyTries || 3;
  options.emfileWait = options.emfileWait || 1000;
  if (options.glob === false) {
    options.disableGlob = true;
  }
  options.disableGlob = options.disableGlob || false;
  options.glob = options.glob || defaultGlobOpts;
}

function rimraf (p, options, cb) {
  if (typeof options === 'function') {
    cb = options;
    options = {};
  }

  assert(p, 'rimraf: missing path');
  assert.equal(typeof p, 'string', 'rimraf: path should be a string');
  assert.equal(typeof cb, 'function', 'rimraf: callback function required');
  assert(options, 'rimraf: invalid options argument provided');
  assert.equal(typeof options, 'object', 'rimraf: options should be object');

  defaults(options);

  var busyTries = 0;
  var errState = null;
  var n = 0;

  if (options.disableGlob || !glob_1.hasMagic(p))
    return afterGlob(null, [p])

  options.lstat(p, function (er, stat) {
    if (!er)
      return afterGlob(null, [p])

    glob_1(p, options.glob, afterGlob);
  });

  function next (er) {
    errState = errState || er;
    if (--n === 0)
      cb(errState);
  }

  function afterGlob (er, results) {
    if (er)
      return cb(er)

    n = results.length;
    if (n === 0)
      return cb()

    results.forEach(function (p) {
      rimraf_(p, options, function CB (er) {
        if (er) {
          if ((er.code === "EBUSY" || er.code === "ENOTEMPTY" || er.code === "EPERM") &&
              busyTries < options.maxBusyTries) {
            busyTries ++;
            var time = busyTries * 100;
            // try again, with the same exact callback as this one.
            return setTimeout(function () {
              rimraf_(p, options, CB);
            }, time)
          }

          // this one won't happen if graceful-fs is used.
          if (er.code === "EMFILE" && timeout < options.emfileWait) {
            return setTimeout(function () {
              rimraf_(p, options, CB);
            }, timeout ++)
          }

          // already gone
          if (er.code === "ENOENT") er = null;
        }

        timeout = 0;
        next(er);
      });
    });
  }
}

// Two possible strategies.
// 1. Assume it's a file.  unlink it, then do the dir stuff on EPERM or EISDIR
// 2. Assume it's a directory.  readdir, then do the file stuff on ENOTDIR
//
// Both result in an extra syscall when you guess wrong.  However, there
// are likely far more normal files in the world than directories.  This
// is based on the assumption that a the average number of files per
// directory is >= 1.
//
// If anyone ever complains about this, then I guess the strategy could
// be made configurable somehow.  But until then, YAGNI.
function rimraf_ (p, options, cb) {
  assert(p);
  assert(options);
  assert(typeof cb === 'function');

  // sunos lets the root user unlink directories, which is... weird.
  // so we have to lstat here and make sure it's not a dir.
  options.lstat(p, function (er, st) {
    if (er && er.code === "ENOENT")
      return cb(null)

    // Windows can EPERM on stat.  Life is suffering.
    if (er && er.code === "EPERM" && isWindows$1)
      fixWinEPERM(p, options, er, cb);

    if (st && st.isDirectory())
      return rmdir(p, options, er, cb)

    options.unlink(p, function (er) {
      if (er) {
        if (er.code === "ENOENT")
          return cb(null)
        if (er.code === "EPERM")
          return (isWindows$1)
            ? fixWinEPERM(p, options, er, cb)
            : rmdir(p, options, er, cb)
        if (er.code === "EISDIR")
          return rmdir(p, options, er, cb)
      }
      return cb(er)
    });
  });
}

function fixWinEPERM (p, options, er, cb) {
  assert(p);
  assert(options);
  assert(typeof cb === 'function');
  if (er)
    assert(er instanceof Error);

  options.chmod(p, _0666, function (er2) {
    if (er2)
      cb(er2.code === "ENOENT" ? null : er);
    else
      options.stat(p, function(er3, stats) {
        if (er3)
          cb(er3.code === "ENOENT" ? null : er);
        else if (stats.isDirectory())
          rmdir(p, options, er, cb);
        else
          options.unlink(p, cb);
      });
  });
}

function fixWinEPERMSync (p, options, er) {
  assert(p);
  assert(options);
  if (er)
    assert(er instanceof Error);

  try {
    options.chmodSync(p, _0666);
  } catch (er2) {
    if (er2.code === "ENOENT")
      return
    else
      throw er
  }

  try {
    var stats = options.statSync(p);
  } catch (er3) {
    if (er3.code === "ENOENT")
      return
    else
      throw er
  }

  if (stats.isDirectory())
    rmdirSync(p, options, er);
  else
    options.unlinkSync(p);
}

function rmdir (p, options, originalEr, cb) {
  assert(p);
  assert(options);
  if (originalEr)
    assert(originalEr instanceof Error);
  assert(typeof cb === 'function');

  // try to rmdir first, and only readdir on ENOTEMPTY or EEXIST (SunOS)
  // if we guessed wrong, and it's not a directory, then
  // raise the original error.
  options.rmdir(p, function (er) {
    if (er && (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM"))
      rmkids(p, options, cb);
    else if (er && er.code === "ENOTDIR")
      cb(originalEr);
    else
      cb(er);
  });
}

function rmkids(p, options, cb) {
  assert(p);
  assert(options);
  assert(typeof cb === 'function');

  options.readdir(p, function (er, files) {
    if (er)
      return cb(er)
    var n = files.length;
    if (n === 0)
      return options.rmdir(p, cb)
    var errState;
    files.forEach(function (f) {
      rimraf(path$1.join(p, f), options, function (er) {
        if (errState)
          return
        if (er)
          return cb(errState = er)
        if (--n === 0)
          options.rmdir(p, cb);
      });
    });
  });
}

// this looks simpler, and is strictly *faster*, but will
// tie up the JavaScript thread and fail on excessively
// deep directory trees.
function rimrafSync (p, options) {
  options = options || {};
  defaults(options);

  assert(p, 'rimraf: missing path');
  assert.equal(typeof p, 'string', 'rimraf: path should be a string');
  assert(options, 'rimraf: missing options');
  assert.equal(typeof options, 'object', 'rimraf: options should be object');

  var results;

  if (options.disableGlob || !glob_1.hasMagic(p)) {
    results = [p];
  } else {
    try {
      options.lstatSync(p);
      results = [p];
    } catch (er) {
      results = glob_1.sync(p, options.glob);
    }
  }

  if (!results.length)
    return

  for (var i = 0; i < results.length; i++) {
    var p = results[i];

    try {
      var st = options.lstatSync(p);
    } catch (er) {
      if (er.code === "ENOENT")
        return

      // Windows can EPERM on stat.  Life is suffering.
      if (er.code === "EPERM" && isWindows$1)
        fixWinEPERMSync(p, options, er);
    }

    try {
      // sunos lets the root user unlink directories, which is... weird.
      if (st && st.isDirectory())
        rmdirSync(p, options, null);
      else
        options.unlinkSync(p);
    } catch (er) {
      if (er.code === "ENOENT")
        return
      if (er.code === "EPERM")
        return isWindows$1 ? fixWinEPERMSync(p, options, er) : rmdirSync(p, options, er)
      if (er.code !== "EISDIR")
        throw er

      rmdirSync(p, options, er);
    }
  }
}

function rmdirSync (p, options, originalEr) {
  assert(p);
  assert(options);
  if (originalEr)
    assert(originalEr instanceof Error);

  try {
    options.rmdirSync(p);
  } catch (er) {
    if (er.code === "ENOENT")
      return
    if (er.code === "ENOTDIR")
      throw originalEr
    if (er.code === "ENOTEMPTY" || er.code === "EEXIST" || er.code === "EPERM")
      rmkidsSync(p, options);
  }
}

function rmkidsSync (p, options) {
  assert(p);
  assert(options);
  options.readdirSync(p).forEach(function (f) {
    rimrafSync(path$1.join(p, f), options);
  });

  // We only end up here once we got ENOTEMPTY at least once, and
  // at this point, we are guaranteed to have removed all the kids.
  // So, we know that it won't be ENOENT or ENOTDIR or anything else.
  // try really hard to delete stuff on windows, because it has a
  // PROFOUNDLY annoying habit of not closing handles promptly when
  // files are deleted, resulting in spurious ENOTEMPTY errors.
  var retries = isWindows$1 ? 100 : 1;
  var i = 0;
  do {
    var threw = true;
    try {
      var ret = options.rmdirSync(p, options);
      threw = false;
      return ret
    } finally {
      if (++i < retries && threw)
        continue
    }
  } while (true)
}

function removeSync(dir) {
  return rimraf_1.sync(dir)
}

function remove(dir, callback) {
  return callback ? rimraf_1(dir, callback) : rimraf_1(dir, function(){})
}

var remove_1 = {
  remove: remove,
  removeSync: removeSync
};

// most of this code was written by Andrew Kelley
// licensed under the BSD license: see
// https://github.com/andrewrk/node-mv/blob/master/package.json

// this needs a cleanup


var ncp$2 = _copy.ncp;


var mkdirp = mkdir.mkdirs;

function mv(source, dest, options, callback){
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  var shouldMkdirp = !!options.mkdirp;
  var clobber = options.clobber !== false;
  var limit = options.limit || 16;

  if (shouldMkdirp) {
    mkdirs();
  } else {
    doRename();
  }

  function mkdirs() {
    mkdirp(path$1.dirname(dest), function(err) {
      if (err) return callback(err)
      doRename();
    });
  }

  function doRename() {
    if (clobber) {
      gracefulFs$1.rename(source, dest, function(err) {
        if (!err) return callback()

        if (err.code === 'ENOTEMPTY') {
          rimraf_1(dest, function(err) {
            if (err) return callback(err)
            options.clobber = false; // just clobbered it, no need to do it again
            mv(source, dest, options, callback);
          });
          return
        }

        if (err.code !== 'EXDEV') return callback(err)
        moveFileAcrossDevice(source, dest, clobber, limit, callback);
      });
    } else {
      gracefulFs$1.link(source, dest, function(err) {
        if (err) {
          if (err.code === 'EXDEV') {
            moveFileAcrossDevice(source, dest, clobber, limit, callback);
            return
          }
          if (err.code === 'EISDIR' || err.code === 'EPERM') {
            moveDirAcrossDevice(source, dest, clobber, limit, callback);
            return
          }
          callback(err);
          return
        }
        gracefulFs$1.unlink(source, callback);
      });
    }
  }
}

function moveFileAcrossDevice(source, dest, clobber, limit, callback) {
  var outFlags = clobber ? 'w' : 'wx';
  var ins = gracefulFs$1.createReadStream(source);
  var outs = gracefulFs$1.createWriteStream(dest, {flags: outFlags});

  ins.on('error', function(err) {
    ins.destroy();
    outs.destroy();
    outs.removeListener('close', onClose);

    // may want to create a directory but `out` line above
    // creates an empty file for us: See #108
    // don't care about error here
    gracefulFs$1.unlink(dest, function() {
      // note: `err` here is from the input stream errror
      if (err.code === 'EISDIR' || err.code === 'EPERM') {
        moveDirAcrossDevice(source, dest, clobber, limit, callback);
      } else {
        callback(err);
      }
    });
  });

  outs.on('error', function(err) {
    ins.destroy();
    outs.destroy();
    outs.removeListener('close', onClose);
    callback(err);
  });

  outs.once('close', onClose);
  ins.pipe(outs);

  function onClose() {
    gracefulFs$1.unlink(source, callback);
  }
}

function moveDirAcrossDevice(source, dest, clobber, limit, callback) {
  var options = {
    stopOnErr: true,
    clobber: false,
    limit: limit,
  };

  function startNcp() {
    ncp$2(source, dest, options, function(errList) {
      if (errList) return callback(errList[0])
      rimraf_1(source, callback);
    });
  }

  if (clobber) {
    rimraf_1(dest, function(err) {
      if (err) return callback(err)
      startNcp();
    });
  } else {
    startNcp();
  }
}

var move = mv;

function outputFile (file, data, encoding, callback) {
  if (typeof encoding === 'function') {
    callback = encoding;
    encoding = 'utf8';
  }

  var dir = path$1.dirname(file);
  gracefulFs$1.exists(dir, function(itDoes) {
    if (itDoes) return gracefulFs$1.writeFile(file, data, encoding, callback)
    
    mkdir.mkdirs(dir, function(err) {
      if (err) return callback(err)
      
      gracefulFs$1.writeFile(file, data, encoding, callback);
    });
  });
}

function outputFileSync (file, data, encoding) {
  var dir = path$1.dirname(file);
  if (gracefulFs$1.existsSync(dir)) 
    return gracefulFs$1.writeFileSync.apply(gracefulFs$1, arguments)
  mkdir.mkdirsSync(dir);
  gracefulFs$1.writeFileSync.apply(gracefulFs$1, arguments);
}

var output = {
  outputFile: outputFile,
  outputFileSync: outputFileSync
};

var fse = {};
var fs$1 = gracefulFs$1;

//attach fs methods to fse
Object.keys(fs$1).forEach(function(key) {
  var func = fs$1[key];
  if (typeof func == 'function')
    fse[key] = func;
});
fs$1 = fse;


fs$1.copy = copy_1.copy;
fs$1.copySync = copy_1.copySync;


fs$1.remove = remove_1.remove;
fs$1.removeSync = remove_1.removeSync;
fs$1['delete'] = fs$1.remove;
fs$1.deleteSync = fs$1.removeSync;


fs$1.mkdirs = mkdir.mkdirs;
fs$1.mkdirsSync = mkdir.mkdirsSync;
fs$1.mkdirp = fs$1.mkdirs;
fs$1.mkdirpSync = fs$1.mkdirsSync;


fs$1.createFile = create.createFile;
fs$1.createFileSync = create.createFileSync;

fs$1.ensureFile = create.createFile;
fs$1.ensureFileSync = create.createFileSync;
fs$1.ensureDir = mkdir.mkdirs;
fs$1.ensureDirSync = mkdir.mkdirsSync;



fs$1.move = function(src, dest, opts, callback) {
  if (typeof opts == 'function') {
    callback = opts;
    opts = {};
  }

  if (opts.mkdirp == null) opts.mkdirp = true;
  if (opts.clobber == null) opts.clobber = false;

  move(src, dest, opts, callback);
};



fs$1.outputFile = output.outputFile;
fs$1.outputFileSync = output.outputFileSync;


fs$1.readJsonFile = jsonfile_1.readFile;
fs$1.readJSONFile = jsonfile_1.readFile;
fs$1.readJsonFileSync = jsonfile_1.readFileSync;
fs$1.readJSONFileSync = jsonfile_1.readFileSync;

fs$1.readJson = jsonfile_1.readFile;
fs$1.readJSON = jsonfile_1.readFile;
fs$1.readJsonSync = jsonfile_1.readFileSync;
fs$1.readJSONSync = jsonfile_1.readFileSync;

fs$1.outputJsonSync = json.outputJsonSync;
fs$1.outputJSONSync = json.outputJsonSync;
fs$1.outputJson = json.outputJson;
fs$1.outputJSON = json.outputJson;

fs$1.writeJsonFile = jsonfile_1.writeFile;
fs$1.writeJSONFile = jsonfile_1.writeFile;
fs$1.writeJsonFileSync = jsonfile_1.writeFileSync;
fs$1.writeJSONFileSync = jsonfile_1.writeFileSync;

fs$1.writeJson = jsonfile_1.writeFile;
fs$1.writeJSON = jsonfile_1.writeFile;
fs$1.writeJsonSync = jsonfile_1.writeFileSync;
fs$1.writeJSONSync = jsonfile_1.writeFileSync;


var lib = fs$1;

jsonfile_1.spaces = 2; //set to 2
var jsonfile$1 = jsonfile_1; //so users of fs-extra can modify jsonFile.spaces
lib.jsonfile = jsonfile$1;

var es6Promise = createCommonjsModule(function (module) {
/*!
 * @overview es6-promise - a tiny implementation of Promises/A+.
 * @copyright Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors (Conversion to ES6 API by Jake Archibald)
 * @license   Licensed under MIT license
 *            See https://raw.githubusercontent.com/jakearchibald/es6-promise/master/LICENSE
 * @version   2.3.0
 */

(function() {
    function lib$es6$promise$utils$$objectOrFunction(x) {
      return typeof x === 'function' || (typeof x === 'object' && x !== null);
    }

    function lib$es6$promise$utils$$isFunction(x) {
      return typeof x === 'function';
    }

    function lib$es6$promise$utils$$isMaybeThenable(x) {
      return typeof x === 'object' && x !== null;
    }

    var lib$es6$promise$utils$$_isArray;
    if (!Array.isArray) {
      lib$es6$promise$utils$$_isArray = function (x) {
        return Object.prototype.toString.call(x) === '[object Array]';
      };
    } else {
      lib$es6$promise$utils$$_isArray = Array.isArray;
    }

    var lib$es6$promise$utils$$isArray = lib$es6$promise$utils$$_isArray;
    var lib$es6$promise$asap$$len = 0;
    var lib$es6$promise$asap$$vertxNext;
    var lib$es6$promise$asap$$customSchedulerFn;

    var lib$es6$promise$asap$$asap = function asap(callback, arg) {
      lib$es6$promise$asap$$queue[lib$es6$promise$asap$$len] = callback;
      lib$es6$promise$asap$$queue[lib$es6$promise$asap$$len + 1] = arg;
      lib$es6$promise$asap$$len += 2;
      if (lib$es6$promise$asap$$len === 2) {
        // If len is 2, that means that we need to schedule an async flush.
        // If additional callbacks are queued before the queue is flushed, they
        // will be processed by this flush that we are scheduling.
        if (lib$es6$promise$asap$$customSchedulerFn) {
          lib$es6$promise$asap$$customSchedulerFn(lib$es6$promise$asap$$flush);
        } else {
          lib$es6$promise$asap$$scheduleFlush();
        }
      }
    };

    function lib$es6$promise$asap$$setScheduler(scheduleFn) {
      lib$es6$promise$asap$$customSchedulerFn = scheduleFn;
    }

    function lib$es6$promise$asap$$setAsap(asapFn) {
      lib$es6$promise$asap$$asap = asapFn;
    }

    var lib$es6$promise$asap$$browserWindow = (typeof window !== 'undefined') ? window : undefined;
    var lib$es6$promise$asap$$browserGlobal = lib$es6$promise$asap$$browserWindow || {};
    var lib$es6$promise$asap$$BrowserMutationObserver = lib$es6$promise$asap$$browserGlobal.MutationObserver || lib$es6$promise$asap$$browserGlobal.WebKitMutationObserver;
    var lib$es6$promise$asap$$isNode = typeof process !== 'undefined' && {}.toString.call(process) === '[object process]';

    // test for web worker but not in IE10
    var lib$es6$promise$asap$$isWorker = typeof Uint8ClampedArray !== 'undefined' &&
      typeof importScripts !== 'undefined' &&
      typeof MessageChannel !== 'undefined';

    // node
    function lib$es6$promise$asap$$useNextTick() {
      var nextTick = process.nextTick;
      // node version 0.10.x displays a deprecation warning when nextTick is used recursively
      // setImmediate should be used instead instead
      var version = process.versions.node.match(/^(?:(\d+)\.)?(?:(\d+)\.)?(\*|\d+)$/);
      if (Array.isArray(version) && version[1] === '0' && version[2] === '10') {
        nextTick = setImmediate;
      }
      return function() {
        nextTick(lib$es6$promise$asap$$flush);
      };
    }

    // vertx
    function lib$es6$promise$asap$$useVertxTimer() {
      return function() {
        lib$es6$promise$asap$$vertxNext(lib$es6$promise$asap$$flush);
      };
    }

    function lib$es6$promise$asap$$useMutationObserver() {
      var iterations = 0;
      var observer = new lib$es6$promise$asap$$BrowserMutationObserver(lib$es6$promise$asap$$flush);
      var node = document.createTextNode('');
      observer.observe(node, { characterData: true });

      return function() {
        node.data = (iterations = ++iterations % 2);
      };
    }

    // web worker
    function lib$es6$promise$asap$$useMessageChannel() {
      var channel = new MessageChannel();
      channel.port1.onmessage = lib$es6$promise$asap$$flush;
      return function () {
        channel.port2.postMessage(0);
      };
    }

    function lib$es6$promise$asap$$useSetTimeout() {
      return function() {
        setTimeout(lib$es6$promise$asap$$flush, 1);
      };
    }

    var lib$es6$promise$asap$$queue = new Array(1000);
    function lib$es6$promise$asap$$flush() {
      for (var i = 0; i < lib$es6$promise$asap$$len; i+=2) {
        var callback = lib$es6$promise$asap$$queue[i];
        var arg = lib$es6$promise$asap$$queue[i+1];

        callback(arg);

        lib$es6$promise$asap$$queue[i] = undefined;
        lib$es6$promise$asap$$queue[i+1] = undefined;
      }

      lib$es6$promise$asap$$len = 0;
    }

    function lib$es6$promise$asap$$attemptVertex() {
      try {
        var r = commonjsRequire;
        var vertx = r('vertx');
        lib$es6$promise$asap$$vertxNext = vertx.runOnLoop || vertx.runOnContext;
        return lib$es6$promise$asap$$useVertxTimer();
      } catch(e) {
        return lib$es6$promise$asap$$useSetTimeout();
      }
    }

    var lib$es6$promise$asap$$scheduleFlush;
    // Decide what async method to use to triggering processing of queued callbacks:
    if (lib$es6$promise$asap$$isNode) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useNextTick();
    } else if (lib$es6$promise$asap$$BrowserMutationObserver) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useMutationObserver();
    } else if (lib$es6$promise$asap$$isWorker) {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useMessageChannel();
    } else if (lib$es6$promise$asap$$browserWindow === undefined && typeof commonjsRequire === 'function') {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$attemptVertex();
    } else {
      lib$es6$promise$asap$$scheduleFlush = lib$es6$promise$asap$$useSetTimeout();
    }

    function lib$es6$promise$$internal$$noop() {}

    var lib$es6$promise$$internal$$PENDING   = void 0;
    var lib$es6$promise$$internal$$FULFILLED = 1;
    var lib$es6$promise$$internal$$REJECTED  = 2;

    var lib$es6$promise$$internal$$GET_THEN_ERROR = new lib$es6$promise$$internal$$ErrorObject();

    function lib$es6$promise$$internal$$selfFullfillment() {
      return new TypeError("You cannot resolve a promise with itself");
    }

    function lib$es6$promise$$internal$$cannotReturnOwn() {
      return new TypeError('A promises callback cannot return that same promise.');
    }

    function lib$es6$promise$$internal$$getThen(promise) {
      try {
        return promise.then;
      } catch(error) {
        lib$es6$promise$$internal$$GET_THEN_ERROR.error = error;
        return lib$es6$promise$$internal$$GET_THEN_ERROR;
      }
    }

    function lib$es6$promise$$internal$$tryThen(then, value, fulfillmentHandler, rejectionHandler) {
      try {
        then.call(value, fulfillmentHandler, rejectionHandler);
      } catch(e) {
        return e;
      }
    }

    function lib$es6$promise$$internal$$handleForeignThenable(promise, thenable, then) {
       lib$es6$promise$asap$$asap(function(promise) {
        var sealed = false;
        var error = lib$es6$promise$$internal$$tryThen(then, thenable, function(value) {
          if (sealed) { return; }
          sealed = true;
          if (thenable !== value) {
            lib$es6$promise$$internal$$resolve(promise, value);
          } else {
            lib$es6$promise$$internal$$fulfill(promise, value);
          }
        }, function(reason) {
          if (sealed) { return; }
          sealed = true;

          lib$es6$promise$$internal$$reject(promise, reason);
        }, 'Settle: ' + (promise._label || ' unknown promise'));

        if (!sealed && error) {
          sealed = true;
          lib$es6$promise$$internal$$reject(promise, error);
        }
      }, promise);
    }

    function lib$es6$promise$$internal$$handleOwnThenable(promise, thenable) {
      if (thenable._state === lib$es6$promise$$internal$$FULFILLED) {
        lib$es6$promise$$internal$$fulfill(promise, thenable._result);
      } else if (thenable._state === lib$es6$promise$$internal$$REJECTED) {
        lib$es6$promise$$internal$$reject(promise, thenable._result);
      } else {
        lib$es6$promise$$internal$$subscribe(thenable, undefined, function(value) {
          lib$es6$promise$$internal$$resolve(promise, value);
        }, function(reason) {
          lib$es6$promise$$internal$$reject(promise, reason);
        });
      }
    }

    function lib$es6$promise$$internal$$handleMaybeThenable(promise, maybeThenable) {
      if (maybeThenable.constructor === promise.constructor) {
        lib$es6$promise$$internal$$handleOwnThenable(promise, maybeThenable);
      } else {
        var then = lib$es6$promise$$internal$$getThen(maybeThenable);

        if (then === lib$es6$promise$$internal$$GET_THEN_ERROR) {
          lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$GET_THEN_ERROR.error);
        } else if (then === undefined) {
          lib$es6$promise$$internal$$fulfill(promise, maybeThenable);
        } else if (lib$es6$promise$utils$$isFunction(then)) {
          lib$es6$promise$$internal$$handleForeignThenable(promise, maybeThenable, then);
        } else {
          lib$es6$promise$$internal$$fulfill(promise, maybeThenable);
        }
      }
    }

    function lib$es6$promise$$internal$$resolve(promise, value) {
      if (promise === value) {
        lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$selfFullfillment());
      } else if (lib$es6$promise$utils$$objectOrFunction(value)) {
        lib$es6$promise$$internal$$handleMaybeThenable(promise, value);
      } else {
        lib$es6$promise$$internal$$fulfill(promise, value);
      }
    }

    function lib$es6$promise$$internal$$publishRejection(promise) {
      if (promise._onerror) {
        promise._onerror(promise._result);
      }

      lib$es6$promise$$internal$$publish(promise);
    }

    function lib$es6$promise$$internal$$fulfill(promise, value) {
      if (promise._state !== lib$es6$promise$$internal$$PENDING) { return; }

      promise._result = value;
      promise._state = lib$es6$promise$$internal$$FULFILLED;

      if (promise._subscribers.length !== 0) {
        lib$es6$promise$asap$$asap(lib$es6$promise$$internal$$publish, promise);
      }
    }

    function lib$es6$promise$$internal$$reject(promise, reason) {
      if (promise._state !== lib$es6$promise$$internal$$PENDING) { return; }
      promise._state = lib$es6$promise$$internal$$REJECTED;
      promise._result = reason;

      lib$es6$promise$asap$$asap(lib$es6$promise$$internal$$publishRejection, promise);
    }

    function lib$es6$promise$$internal$$subscribe(parent, child, onFulfillment, onRejection) {
      var subscribers = parent._subscribers;
      var length = subscribers.length;

      parent._onerror = null;

      subscribers[length] = child;
      subscribers[length + lib$es6$promise$$internal$$FULFILLED] = onFulfillment;
      subscribers[length + lib$es6$promise$$internal$$REJECTED]  = onRejection;

      if (length === 0 && parent._state) {
        lib$es6$promise$asap$$asap(lib$es6$promise$$internal$$publish, parent);
      }
    }

    function lib$es6$promise$$internal$$publish(promise) {
      var subscribers = promise._subscribers;
      var settled = promise._state;

      if (subscribers.length === 0) { return; }

      var child, callback, detail = promise._result;

      for (var i = 0; i < subscribers.length; i += 3) {
        child = subscribers[i];
        callback = subscribers[i + settled];

        if (child) {
          lib$es6$promise$$internal$$invokeCallback(settled, child, callback, detail);
        } else {
          callback(detail);
        }
      }

      promise._subscribers.length = 0;
    }

    function lib$es6$promise$$internal$$ErrorObject() {
      this.error = null;
    }

    var lib$es6$promise$$internal$$TRY_CATCH_ERROR = new lib$es6$promise$$internal$$ErrorObject();

    function lib$es6$promise$$internal$$tryCatch(callback, detail) {
      try {
        return callback(detail);
      } catch(e) {
        lib$es6$promise$$internal$$TRY_CATCH_ERROR.error = e;
        return lib$es6$promise$$internal$$TRY_CATCH_ERROR;
      }
    }

    function lib$es6$promise$$internal$$invokeCallback(settled, promise, callback, detail) {
      var hasCallback = lib$es6$promise$utils$$isFunction(callback),
          value, error, succeeded, failed;

      if (hasCallback) {
        value = lib$es6$promise$$internal$$tryCatch(callback, detail);

        if (value === lib$es6$promise$$internal$$TRY_CATCH_ERROR) {
          failed = true;
          error = value.error;
          value = null;
        } else {
          succeeded = true;
        }

        if (promise === value) {
          lib$es6$promise$$internal$$reject(promise, lib$es6$promise$$internal$$cannotReturnOwn());
          return;
        }

      } else {
        value = detail;
        succeeded = true;
      }

      if (promise._state !== lib$es6$promise$$internal$$PENDING) ; else if (hasCallback && succeeded) {
        lib$es6$promise$$internal$$resolve(promise, value);
      } else if (failed) {
        lib$es6$promise$$internal$$reject(promise, error);
      } else if (settled === lib$es6$promise$$internal$$FULFILLED) {
        lib$es6$promise$$internal$$fulfill(promise, value);
      } else if (settled === lib$es6$promise$$internal$$REJECTED) {
        lib$es6$promise$$internal$$reject(promise, value);
      }
    }

    function lib$es6$promise$$internal$$initializePromise(promise, resolver) {
      try {
        resolver(function resolvePromise(value){
          lib$es6$promise$$internal$$resolve(promise, value);
        }, function rejectPromise(reason) {
          lib$es6$promise$$internal$$reject(promise, reason);
        });
      } catch(e) {
        lib$es6$promise$$internal$$reject(promise, e);
      }
    }

    function lib$es6$promise$enumerator$$Enumerator(Constructor, input) {
      var enumerator = this;

      enumerator._instanceConstructor = Constructor;
      enumerator.promise = new Constructor(lib$es6$promise$$internal$$noop);

      if (enumerator._validateInput(input)) {
        enumerator._input     = input;
        enumerator.length     = input.length;
        enumerator._remaining = input.length;

        enumerator._init();

        if (enumerator.length === 0) {
          lib$es6$promise$$internal$$fulfill(enumerator.promise, enumerator._result);
        } else {
          enumerator.length = enumerator.length || 0;
          enumerator._enumerate();
          if (enumerator._remaining === 0) {
            lib$es6$promise$$internal$$fulfill(enumerator.promise, enumerator._result);
          }
        }
      } else {
        lib$es6$promise$$internal$$reject(enumerator.promise, enumerator._validationError());
      }
    }

    lib$es6$promise$enumerator$$Enumerator.prototype._validateInput = function(input) {
      return lib$es6$promise$utils$$isArray(input);
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._validationError = function() {
      return new Error('Array Methods must be provided an Array');
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._init = function() {
      this._result = new Array(this.length);
    };

    var lib$es6$promise$enumerator$$default = lib$es6$promise$enumerator$$Enumerator;

    lib$es6$promise$enumerator$$Enumerator.prototype._enumerate = function() {
      var enumerator = this;

      var length  = enumerator.length;
      var promise = enumerator.promise;
      var input   = enumerator._input;

      for (var i = 0; promise._state === lib$es6$promise$$internal$$PENDING && i < length; i++) {
        enumerator._eachEntry(input[i], i);
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._eachEntry = function(entry, i) {
      var enumerator = this;
      var c = enumerator._instanceConstructor;

      if (lib$es6$promise$utils$$isMaybeThenable(entry)) {
        if (entry.constructor === c && entry._state !== lib$es6$promise$$internal$$PENDING) {
          entry._onerror = null;
          enumerator._settledAt(entry._state, i, entry._result);
        } else {
          enumerator._willSettleAt(c.resolve(entry), i);
        }
      } else {
        enumerator._remaining--;
        enumerator._result[i] = entry;
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._settledAt = function(state, i, value) {
      var enumerator = this;
      var promise = enumerator.promise;

      if (promise._state === lib$es6$promise$$internal$$PENDING) {
        enumerator._remaining--;

        if (state === lib$es6$promise$$internal$$REJECTED) {
          lib$es6$promise$$internal$$reject(promise, value);
        } else {
          enumerator._result[i] = value;
        }
      }

      if (enumerator._remaining === 0) {
        lib$es6$promise$$internal$$fulfill(promise, enumerator._result);
      }
    };

    lib$es6$promise$enumerator$$Enumerator.prototype._willSettleAt = function(promise, i) {
      var enumerator = this;

      lib$es6$promise$$internal$$subscribe(promise, undefined, function(value) {
        enumerator._settledAt(lib$es6$promise$$internal$$FULFILLED, i, value);
      }, function(reason) {
        enumerator._settledAt(lib$es6$promise$$internal$$REJECTED, i, reason);
      });
    };
    function lib$es6$promise$promise$all$$all(entries) {
      return new lib$es6$promise$enumerator$$default(this, entries).promise;
    }
    var lib$es6$promise$promise$all$$default = lib$es6$promise$promise$all$$all;
    function lib$es6$promise$promise$race$$race(entries) {
      /*jshint validthis:true */
      var Constructor = this;

      var promise = new Constructor(lib$es6$promise$$internal$$noop);

      if (!lib$es6$promise$utils$$isArray(entries)) {
        lib$es6$promise$$internal$$reject(promise, new TypeError('You must pass an array to race.'));
        return promise;
      }

      var length = entries.length;

      function onFulfillment(value) {
        lib$es6$promise$$internal$$resolve(promise, value);
      }

      function onRejection(reason) {
        lib$es6$promise$$internal$$reject(promise, reason);
      }

      for (var i = 0; promise._state === lib$es6$promise$$internal$$PENDING && i < length; i++) {
        lib$es6$promise$$internal$$subscribe(Constructor.resolve(entries[i]), undefined, onFulfillment, onRejection);
      }

      return promise;
    }
    var lib$es6$promise$promise$race$$default = lib$es6$promise$promise$race$$race;
    function lib$es6$promise$promise$resolve$$resolve(object) {
      /*jshint validthis:true */
      var Constructor = this;

      if (object && typeof object === 'object' && object.constructor === Constructor) {
        return object;
      }

      var promise = new Constructor(lib$es6$promise$$internal$$noop);
      lib$es6$promise$$internal$$resolve(promise, object);
      return promise;
    }
    var lib$es6$promise$promise$resolve$$default = lib$es6$promise$promise$resolve$$resolve;
    function lib$es6$promise$promise$reject$$reject(reason) {
      /*jshint validthis:true */
      var Constructor = this;
      var promise = new Constructor(lib$es6$promise$$internal$$noop);
      lib$es6$promise$$internal$$reject(promise, reason);
      return promise;
    }
    var lib$es6$promise$promise$reject$$default = lib$es6$promise$promise$reject$$reject;

    var lib$es6$promise$promise$$counter = 0;

    function lib$es6$promise$promise$$needsResolver() {
      throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
    }

    function lib$es6$promise$promise$$needsNew() {
      throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
    }

    var lib$es6$promise$promise$$default = lib$es6$promise$promise$$Promise;
    /**
      Promise objects represent the eventual result of an asynchronous operation. The
      primary way of interacting with a promise is through its `then` method, which
      registers callbacks to receive either a promise's eventual value or the reason
      why the promise cannot be fulfilled.

      Terminology
      -----------

      - `promise` is an object or function with a `then` method whose behavior conforms to this specification.
      - `thenable` is an object or function that defines a `then` method.
      - `value` is any legal JavaScript value (including undefined, a thenable, or a promise).
      - `exception` is a value that is thrown using the throw statement.
      - `reason` is a value that indicates why a promise was rejected.
      - `settled` the final resting state of a promise, fulfilled or rejected.

      A promise can be in one of three states: pending, fulfilled, or rejected.

      Promises that are fulfilled have a fulfillment value and are in the fulfilled
      state.  Promises that are rejected have a rejection reason and are in the
      rejected state.  A fulfillment value is never a thenable.

      Promises can also be said to *resolve* a value.  If this value is also a
      promise, then the original promise's settled state will match the value's
      settled state.  So a promise that *resolves* a promise that rejects will
      itself reject, and a promise that *resolves* a promise that fulfills will
      itself fulfill.


      Basic Usage:
      ------------

      ```js
      var promise = new Promise(function(resolve, reject) {
        // on success
        resolve(value);

        // on failure
        reject(reason);
      });

      promise.then(function(value) {
        // on fulfillment
      }, function(reason) {
        // on rejection
      });
      ```

      Advanced Usage:
      ---------------

      Promises shine when abstracting away asynchronous interactions such as
      `XMLHttpRequest`s.

      ```js
      function getJSON(url) {
        return new Promise(function(resolve, reject){
          var xhr = new XMLHttpRequest();

          xhr.open('GET', url);
          xhr.onreadystatechange = handler;
          xhr.responseType = 'json';
          xhr.setRequestHeader('Accept', 'application/json');
          xhr.send();

          function handler() {
            if (this.readyState === this.DONE) {
              if (this.status === 200) {
                resolve(this.response);
              } else {
                reject(new Error('getJSON: `' + url + '` failed with status: [' + this.status + ']'));
              }
            }
          };
        });
      }

      getJSON('/posts.json').then(function(json) {
        // on fulfillment
      }, function(reason) {
        // on rejection
      });
      ```

      Unlike callbacks, promises are great composable primitives.

      ```js
      Promise.all([
        getJSON('/posts'),
        getJSON('/comments')
      ]).then(function(values){
        values[0] // => postsJSON
        values[1] // => commentsJSON

        return values;
      });
      ```

      @class Promise
      @param {function} resolver
      Useful for tooling.
      @constructor
    */
    function lib$es6$promise$promise$$Promise(resolver) {
      this._id = lib$es6$promise$promise$$counter++;
      this._state = undefined;
      this._result = undefined;
      this._subscribers = [];

      if (lib$es6$promise$$internal$$noop !== resolver) {
        if (!lib$es6$promise$utils$$isFunction(resolver)) {
          lib$es6$promise$promise$$needsResolver();
        }

        if (!(this instanceof lib$es6$promise$promise$$Promise)) {
          lib$es6$promise$promise$$needsNew();
        }

        lib$es6$promise$$internal$$initializePromise(this, resolver);
      }
    }

    lib$es6$promise$promise$$Promise.all = lib$es6$promise$promise$all$$default;
    lib$es6$promise$promise$$Promise.race = lib$es6$promise$promise$race$$default;
    lib$es6$promise$promise$$Promise.resolve = lib$es6$promise$promise$resolve$$default;
    lib$es6$promise$promise$$Promise.reject = lib$es6$promise$promise$reject$$default;
    lib$es6$promise$promise$$Promise._setScheduler = lib$es6$promise$asap$$setScheduler;
    lib$es6$promise$promise$$Promise._setAsap = lib$es6$promise$asap$$setAsap;
    lib$es6$promise$promise$$Promise._asap = lib$es6$promise$asap$$asap;

    lib$es6$promise$promise$$Promise.prototype = {
      constructor: lib$es6$promise$promise$$Promise,

    /**
      The primary way of interacting with a promise is through its `then` method,
      which registers callbacks to receive either a promise's eventual value or the
      reason why the promise cannot be fulfilled.

      ```js
      findUser().then(function(user){
        // user is available
      }, function(reason){
        // user is unavailable, and you are given the reason why
      });
      ```

      Chaining
      --------

      The return value of `then` is itself a promise.  This second, 'downstream'
      promise is resolved with the return value of the first promise's fulfillment
      or rejection handler, or rejected if the handler throws an exception.

      ```js
      findUser().then(function (user) {
        return user.name;
      }, function (reason) {
        return 'default name';
      }).then(function (userName) {
        // If `findUser` fulfilled, `userName` will be the user's name, otherwise it
        // will be `'default name'`
      });

      findUser().then(function (user) {
        throw new Error('Found user, but still unhappy');
      }, function (reason) {
        throw new Error('`findUser` rejected and we're unhappy');
      }).then(function (value) {
        // never reached
      }, function (reason) {
        // if `findUser` fulfilled, `reason` will be 'Found user, but still unhappy'.
        // If `findUser` rejected, `reason` will be '`findUser` rejected and we're unhappy'.
      });
      ```
      If the downstream promise does not specify a rejection handler, rejection reasons will be propagated further downstream.

      ```js
      findUser().then(function (user) {
        throw new PedagogicalException('Upstream error');
      }).then(function (value) {
        // never reached
      }).then(function (value) {
        // never reached
      }, function (reason) {
        // The `PedgagocialException` is propagated all the way down to here
      });
      ```

      Assimilation
      ------------

      Sometimes the value you want to propagate to a downstream promise can only be
      retrieved asynchronously. This can be achieved by returning a promise in the
      fulfillment or rejection handler. The downstream promise will then be pending
      until the returned promise is settled. This is called *assimilation*.

      ```js
      findUser().then(function (user) {
        return findCommentsByAuthor(user);
      }).then(function (comments) {
        // The user's comments are now available
      });
      ```

      If the assimliated promise rejects, then the downstream promise will also reject.

      ```js
      findUser().then(function (user) {
        return findCommentsByAuthor(user);
      }).then(function (comments) {
        // If `findCommentsByAuthor` fulfills, we'll have the value here
      }, function (reason) {
        // If `findCommentsByAuthor` rejects, we'll have the reason here
      });
      ```

      Simple Example
      --------------

      Synchronous Example

      ```javascript
      var result;

      try {
        result = findResult();
        // success
      } catch(reason) {
        // failure
      }
      ```

      Errback Example

      ```js
      findResult(function(result, err){
        if (err) {
          // failure
        } else {
          // success
        }
      });
      ```

      Promise Example;

      ```javascript
      findResult().then(function(result){
        // success
      }, function(reason){
        // failure
      });
      ```

      Advanced Example
      --------------

      Synchronous Example

      ```javascript
      var author, books;

      try {
        author = findAuthor();
        books  = findBooksByAuthor(author);
        // success
      } catch(reason) {
        // failure
      }
      ```

      Errback Example

      ```js

      function foundBooks(books) {

      }

      function failure(reason) {

      }

      findAuthor(function(author, err){
        if (err) {
          failure(err);
          // failure
        } else {
          try {
            findBoooksByAuthor(author, function(books, err) {
              if (err) {
                failure(err);
              } else {
                try {
                  foundBooks(books);
                } catch(reason) {
                  failure(reason);
                }
              }
            });
          } catch(error) {
            failure(err);
          }
          // success
        }
      });
      ```

      Promise Example;

      ```javascript
      findAuthor().
        then(findBooksByAuthor).
        then(function(books){
          // found books
      }).catch(function(reason){
        // something went wrong
      });
      ```

      @method then
      @param {Function} onFulfilled
      @param {Function} onRejected
      Useful for tooling.
      @return {Promise}
    */
      then: function(onFulfillment, onRejection) {
        var parent = this;
        var state = parent._state;

        if (state === lib$es6$promise$$internal$$FULFILLED && !onFulfillment || state === lib$es6$promise$$internal$$REJECTED && !onRejection) {
          return this;
        }

        var child = new this.constructor(lib$es6$promise$$internal$$noop);
        var result = parent._result;

        if (state) {
          var callback = arguments[state - 1];
          lib$es6$promise$asap$$asap(function(){
            lib$es6$promise$$internal$$invokeCallback(state, child, callback, result);
          });
        } else {
          lib$es6$promise$$internal$$subscribe(parent, child, onFulfillment, onRejection);
        }

        return child;
      },

    /**
      `catch` is simply sugar for `then(undefined, onRejection)` which makes it the same
      as the catch block of a try/catch statement.

      ```js
      function findAuthor(){
        throw new Error('couldn't find that author');
      }

      // synchronous
      try {
        findAuthor();
      } catch(reason) {
        // something went wrong
      }

      // async with promises
      findAuthor().catch(function(reason){
        // something went wrong
      });
      ```

      @method catch
      @param {Function} onRejection
      Useful for tooling.
      @return {Promise}
    */
      'catch': function(onRejection) {
        return this.then(null, onRejection);
      }
    };
    function lib$es6$promise$polyfill$$polyfill() {
      var local;

      if (typeof commonjsGlobal !== 'undefined') {
          local = commonjsGlobal;
      } else if (typeof self !== 'undefined') {
          local = self;
      } else {
          try {
              local = Function('return this')();
          } catch (e) {
              throw new Error('polyfill failed because global object is unavailable in this environment');
          }
      }

      var P = local.Promise;

      if (P && Object.prototype.toString.call(P.resolve()) === '[object Promise]' && !P.cast) {
        return;
      }

      local.Promise = lib$es6$promise$promise$$default;
    }
    var lib$es6$promise$polyfill$$default = lib$es6$promise$polyfill$$polyfill;

    var lib$es6$promise$umd$$ES6Promise = {
      'Promise': lib$es6$promise$promise$$default,
      'polyfill': lib$es6$promise$polyfill$$default
    };

    /* global define:true module:true window: true */
    if (module['exports']) {
      module['exports'] = lib$es6$promise$umd$$ES6Promise;
    } else if (typeof this !== 'undefined') {
      this['ES6Promise'] = lib$es6$promise$umd$$ES6Promise;
    }

    lib$es6$promise$polyfill$$default();
}).call(commonjsGlobal);
});

/// <reference path="../typings/tsd.d.ts" />
/// <reference path="./FsPromise.d.ts" />


var Promise = es6Promise.Promise;
var FsPromise = (function () {
    function FsPromise() {
    }
    FsPromise.prototype.copy = function (src, dest, filter) {
        return this.getFsPromise("copy", [src, dest, filter].filter(function (arg) { return !!arg; }));
    };
    FsPromise.prototype.copySync = function (src, dest, filter) {
        lib.copySync(src, dest, filter);
    };
    FsPromise.prototype.createFile = function (file) {
        return this.getFsPromise("createFile", [file]);
    };
    FsPromise.prototype.createFileSync = function (file) {
        lib.createFileSync(file);
    };
    FsPromise.prototype.mkdirs = function (dir) {
        return this.getFsPromise("mkdirs", [dir]);
    };
    FsPromise.prototype.mkdirsSync = function (dir) {
        lib.mkdirsSync(dir);
    };
    FsPromise.prototype.outputFile = function (file, data) {
        return this.getFsPromise("outputFile", [file, data]);
    };
    FsPromise.prototype.outputFileSync = function (file, data) {
        lib.outputFileSync(file, data);
    };
    FsPromise.prototype.outputJSON = function (file, data) {
        return this.getFsPromise("outputJSON", [file, data]);
    };
    FsPromise.prototype.outputJSONSync = function (file, data) {
        lib.outputJSONSync(file, data);
    };
    FsPromise.prototype.readJSON = function (file, options) {
        return this.getFsPromise("readJSON", [file, options]);
    };
    FsPromise.prototype.readJSONSync = function (file, options) {
        return lib.readJSONSync(file, options);
    };
    FsPromise.prototype.remove = function (dir) {
        return this.getFsPromise("remove", [dir]);
    };
    FsPromise.prototype.removeSync = function (dir) {
        lib.removeSync(dir);
    };
    FsPromise.prototype.writeJSON = function (file, object, options) {
        return this.getFsPromise("writeJSON", [file, object, options]);
    };
    FsPromise.prototype.writeJSONSync = function (file, object, options) {
        lib.writeJSONSync(file, object, options);
    };
    FsPromise.prototype.rename = function (oldPath, newPath) {
        return this.getFsPromise("rename", [oldPath, newPath]);
    };
    FsPromise.prototype.renameSync = function (oldPath, newPath) {
        lib.renameSync(oldPath, newPath);
    };
    FsPromise.prototype.truncate = function (fd, len) {
        return this.getFsPromise("truncate", [fd, len]);
    };
    FsPromise.prototype.truncateSync = function (fd, len) {
        lib.truncateSync(fd, len);
    };
    FsPromise.prototype.chown = function (path, uid, gid) {
        return this.getFsPromise("chown", [path, uid, gid]);
    };
    FsPromise.prototype.chownSync = function (path, uid, gid) {
        lib.chownSync(path, uid, gid);
    };
    FsPromise.prototype.fchown = function (fd, uid, gid) {
        return this.getFsPromise("fchown", [fd, uid, gid]);
    };
    FsPromise.prototype.fchownSync = function (fd, uid, gid) {
        lib.fchownSync(fd, uid, gid);
    };
    FsPromise.prototype.lchown = function (path, uid, gid) {
        return this.getFsPromise("lchown", [path, uid, gid]);
    };
    FsPromise.prototype.lchownSync = function (path, uid, gid) {
        lib.lchownSync(path, uid, gid);
    };
    FsPromise.prototype.chmodSync = function (path, mode) {
        lib.chmodSync(path, mode);
    };
    FsPromise.prototype.fchmod = function (fd, mode) {
        return this.getFsPromise("fchmod", [fd, mode]);
    };
    FsPromise.prototype.fchmodSync = function (fd, mode) {
        lib.fchmodSync(fd, mode);
    };
    FsPromise.prototype.lchmod = function (path, mode) {
        return this.getFsPromise("lchmod", [path, mode]);
    };
    FsPromise.prototype.lchmodSync = function (path, mode) {
        lib.lchmodSync(path, mode);
    };
    FsPromise.prototype.stat = function (path) {
        return this.getFsPromise("stat", [path]);
    };
    FsPromise.prototype.statSync = function (path) {
        return lib.statSync(path);
    };
    FsPromise.prototype.readFile = function (path, encoding) {
        return this.getFsPromise("readFile", [path, encoding]);
    };
    FsPromise.prototype.readFileSync = function (filename, encoding) {
        return lib.readFileSync(filename, encoding);
    };
    FsPromise.prototype.writeFile = function (filename, data, encoding) {
        return this.getFsPromise("writeFile", [filename, data, encoding]);
    };
    FsPromise.prototype.writeFileSync = function (filename, data, encoding) {
        lib.writeFileSync(filename, data, encoding);
    };
    FsPromise.prototype.readdir = function (path) {
        return this.getFsPromise("readdir", [path]);
    };
    FsPromise.prototype.readdirSync = function (path) {
        return lib.readdirSync(path);
    };
    FsPromise.prototype.getFsPromise = function (method, args) {
        return new Promise(function (resolve, reject) {
            var callback = function (err, data) {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(data || true);
                }
            };
            args.push(callback);
            lib[method].apply(lib, args);
        });
    };
    return FsPromise;
})();
var FsPromise_1 = FsPromise;

var fsPromise = new FsPromise_1();
var tsFsPromise = fsPromise;

export default tsFsPromise;
