/* global Map Set */

// server.js

// idea from https://twitter.com/rem/status/1032581950098292736

// init project
const express = require('express');
const app = express();
const fs = require('fs');
const util = require('util');
const Busboy = require('busboy');
const imagemin = require('imagemin');
const imageminJpegtran = require('imagemin-jpegtran');
const imageminPngquant = require('imagemin-pngquant');
const imageminGifsicle = require('imagemin-gifsicle');
const uuid = require('uuid-v6');
const dayjs = require('dayjs');
const prettyBytes = require('pretty-bytes');

// "imagemin-jpegtran": "^5.0.2",
// "imagemin-jpegoptim": "^5.2.0",
// "imagemin-mozjpeg": "^7.0.0",
// "imagemin-pngquant": "^6.0.0",
// "imagemin-optipng": "^5.2.1",
// "imagemin-pngcrush": "^5.1.0",
// "imagemin-pngout": "^3.0.0",
// "imagemin-advpng": "^4.0.0",
// "imagemin-optipng-interlaced": "^5.2.1",
// "imagemin-gifsicle": "^5.2.0",
// "imagemin-giflossy": "^5.1.10",
// "imagemin-webp": "^4.1.0",

const SKIP_FILE_SIZE = +process.env.MAX_FILE_SIZE || -1;

const slots = new Set();
const minified = new Map();

function imageminBuf(buf, callback) {
  imagemin.buffer(buf, {
    plugins: [
      imageminJpegtran({
        progressive: false,
      }),
      imageminPngquant({
        floyd: 0.5, // level of dithering (0.0 - 1.0)
        quality: '65-80'
      }),
      imageminGifsicle({
        interlaced: false,
        optimizationLevel: 1 // 1-3 - 2 user transp, 3 - auto (slow)
      })
    ]
  }).then(function(files) { callback(null, files); }, callback);
}

function isImageFile(mimetype) {
  if (mimetype === 'image/jpeg' || mimetype === 'image/png' || mimetype === 'image/gif') {
    return true;
  }
  return false;
}

// http://expressjs.com/en/starter/static-files.html
app.use(express.static('public'));

// http://expressjs.com/en/starter/basic-routing.html
app.get('/', function(request, response) {
  response.sendFile(__dirname + '/views/index.html');
});

app.get('/upload', function(req, res, next) {
  if (minified.size > 20) {
    return next(new Error('Queue is full. Please wait.'));
  }

  const uid = uuid.v6();
  // TODO: send slot uid as cookie for reuse
  slots.add(uid);

  res.writeHead(200, {'content-type': 'text/html'});
  res.end(`<!doctype html>
<html>
<head>
<style>
body>div{display:none;}
body.submitted form{display:none;}
body.submitted>div{display:block;}
</style>
</head>
<body>
<form action="/upload/${uid}" enctype="multipart/form-data" method="post" onsubmit="document.body.classList.toggle('submitted');return true">
<input type="file" name="upload" multiple="multiple"><br>
<button type="submit">Upload</button>
</form>
<div><p>Sending...</p><button type="button" onclick="location.reload()">Upload another</button></div>
</body>
</html>`
  );
});

app.post('/upload/:uid', function(req, res, next) {
  const uid = req.params.uid;
  
  if (!slots.has(uid)) {
    return next(new Error('Invalid request.'));
  }
  
  if (minified.size > 20) {
    return next(new Error('Queue is full. Please wait and re-submit.'));
  }

  slots.delete(uid);

  let fnam;
  let typ;
  let buf;

  const busboy = new Busboy({
    headers: req.headers,
    limits: {
      fields: 0,
      files: 1,
      fileSize: SKIP_FILE_SIZE > 0 ? SKIP_FILE_SIZE : Infinity,
    }
  });
  
  /*
  Field [title]: value: 'test'
8:38 AM
File [upload]: filename: Screen Shot 2018-06-24 at 10.48.17 pm.png, encoding: 7bit, mimetype: image/png
8:38 AM
File [upload] got 7926 bytes
8:38 AM
...
File [upload] got 2797 bytes
8:38 AM
File [upload] Finished
8:38 AM
Done parsing form!
  */

  busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
    console.log(`File [${fieldname}]: filename: ${filename}, encoding: ${encoding}, mimetype: ${mimetype}`);

    if (!isImageFile(mimetype)) {
      const err = new Error('File is not a valid image type.')
      console.error(err);
      return next(err);
    }
    
    // let totalBytes = 0;
    const bufs = [];

    file.on('data', function(data) {
      // console.log(`File [${fieldname}] got ${data.length} bytes`);
      // totalBytes += data.length;      
      // console.log(`File size (so far) is ${totalBytes} bytes`);
      bufs.push(data);
    });
    
    file.on('end', function() {
      console.log(`File [${fieldname}] Finished.`);
      // console.log(`Total file size: ${totalBytes}`);
      
      if (file.truncated) {
        const err = new Error('File was truncated.');
        console.error(err);
        return;
      }

      fnam = filename;
      typ = mimetype;
      buf = Buffer.concat(bufs);
    });
  });
  
  // busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) {
  //   console.log(`Field [${fieldname}]: value: ${util.inspect(val)});
  // });
  
  busboy.on('finish', function() {
    console.log('Done parsing form!');

    if (!buf.length) {
      const err = new Error('File is empty.');
      console.error(err);
      return next(err);
    }
    
    imageminBuf(buf, function(err, file) {
      if (err) next(err);
      
      console.log(`Optimized! Final file size reduced from ${buf.length} to ${file.length} bytes`);

      console.log(`UUID: ${uid}`);
      minified.set(uid, {
        filename: fnam,
        filesize: buf.length,
        mimetype: typ,
        buffer: file
      });
      
      const minutes = 5;
      const expires = dayjs().add(minutes, 'minutes');
      setTimeout(function() {
        minified.delete(uid);
      }, minutes * 60 * 1000);

      res.writeHead(303, { Connection: 'close', Location: `/result/${uid}` }); // ?expires=${expires.toISOString()}` });
      res.end();
    });
  });
  
  busboy.on('filesLimit', function() {
    console.log('Files limit reached!', arguments);
    res.writeHead(303, { Connection: 'close', Location: '/upload?err=files' });
    res.end();
  });
  
  busboy.on('fieldsLimit', function() {
    console.log('Fields limit reached!');
    res.writeHead(303, { Connection: 'close', Location: '/upload?err=fields' });
    res.end();
  });
  
  req.pipe(busboy);
});

app.get('/result/:uid', function(req, res, next) {
  const uid = req.params.uid;
  
  if (!minified.has(uid)) {
    return next(new Error('Invalid request.'));
  }

  const {
    filename,
    filesize,
    mimetype,
    buffer
  } = minified.get(uid);

  res.writeHead(200, {'content-type': 'text/html'});
  res.end(
    `<p>${prettyBytes(filesize)} -&gt; ${prettyBytes(buffer.length)}</p>`+
    `<img src="/minified/${uid}" />`
  );
});

app.get('/minified/:uid', function(req, res, next) {
  const uid = req.params.uid;
  
  if (!minified.has(uid)) {
    return next(new Error('Invalid request.'));
  }
  
  const {
    filename,
    mimetype,
    buffer
  } = minified.get(uid);

  minified.delete(uid);

  res.writeHead(200, {
    'Content-Type': mimetype,
    'Content-Length': buffer.length,
    'Content-Disposition': `filename=${filename}`
  });
  res.end(buffer, 'binary');
});

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.status(500).send(err.message);
});

// listen for requests :)
const listener = app.listen(process.env.PORT, function() {
  console.log(`Your app is listening on port ${listener.address().port}`);
});
