const express = require('express');
const ytdl = require('@distube/ytdl-core');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Production middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "https://i.ytimg.com", "https://img.youtube.com"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

app.use(express.json({ limit: '10kb' }));

// Rate limiting to prevent abuse
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

app.use('/api/', apiLimiter);

// Serve the single index.html at the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Look up video info + available formats
app.get('/api/info', async (req, res, next) => {
  const url = req.query.url;

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const info = await ytdl.getInfo(url);

    const formats = info.formats
      .filter((f) => f.hasVideo && f.hasAudio && f.container === 'mp4' && f.qualityLabel)
      .map((f) => ({
        itag: f.itag,
        qualityLabel: f.qualityLabel,
        container: f.container,
        approxSizeMB: f.contentLength
          ? (Number(f.contentLength) / (1024 * 1024)).toFixed(1)
          : null,
      }));

    res.json({
      title: info.videoDetails.title,
      author: info.videoDetails.author?.name || 'Unknown',
      lengthSeconds: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails?.at(-1)?.url || '',
      formats,
    });
  } catch (err) {
    console.error('[info]', err.message);
    
    // Don't leak internal error details in production
    const message = NODE_ENV === 'production'
      ? 'Could not fetch video info. The video may be private, age-restricted, or unavailable.'
      : err.message;
    
    res.status(500).json({ error: message });
  }
});

// RFC 5987-safe Content-Disposition
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Stream download
app.get('/api/download', async (req, res, next) => {
  const { url, itag } = req.query;

  if (!url || !ytdl.validateURL(url) || !itag) {
    return res.status(400).send('Missing or invalid url/itag.');
  }

  try {
    const info = await ytdl.getInfo(url);
    const format = info.formats.find((f) => String(f.itag) === String(itag));

    if (!format) {
      return res.status(404).send('Requested format not available.');
    }

    const rawTitle = info.videoDetails.title.replace(/[^\w\s.-]/g, '').trim() || 'video';
    const filename = `${rawTitle}.mp4`;

    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Type', 'video/mp4');
    if (format.contentLength) {
      res.setHeader('Content-Length', format.contentLength);
    }

    const stream = ytdl.downloadFromInfo(info, { format });

    stream.on('error', (err) => {
      console.error('[download]', err.message);
      if (!res.headersSent) {
        res.status(500).send('Download failed.');
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);
  } catch (err) {
    console.error('[download]', err.message);
    if (!res.headersSent) {
      res.status(500).send('Download failed.');
    }
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[global]', err.stack);
  res.status(500).json({ error: 'Internal server error.' });
});

// Graceful shutdown
const server = app.listen(PORT, () => {
  console.log(`ytdl-site running at http://localhost:${PORT} [${NODE_ENV}]`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
