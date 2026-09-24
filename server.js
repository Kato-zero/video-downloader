const express = require('express');
const ytdl = require('@distube/ytdl-core');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Look up video info + available formats for a given YouTube URL
app.get('/api/info', async (req, res) => {
  const url = req.query.url;

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }

  try {
    const info = await ytdl.getInfo(url);

    // Only expose formats that have both a direct itag and a readable quality label,
    // and that include audio (progressive formats), so the "download" step is simple.
    const formats = info.formats
      .filter((f) => f.hasVideo && f.hasAudio && f.container === 'mp4')
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
      author: info.videoDetails.author.name,
      lengthSeconds: info.videoDetails.lengthSeconds,
      thumbnail: info.videoDetails.thumbnails.at(-1)?.url,
      formats,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch video info. The video may be private, age-restricted, or unavailable.' });
  }
});

// Stream the chosen format directly to the browser as a download
app.get('/api/download', async (req, res) => {
  const { url, itag } = req.query;

  if (!url || !ytdl.validateURL(url) || !itag) {
    return res.status(400).send('Missing or invalid url/itag.');
  }

  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^\w\s-]/g, '').trim() || 'video';

    res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);

    ytdl(url, { quality: itag })
      .on('error', (err) => {
        console.error(err);
        if (!res.headersSent) res.status(500).send('Download failed.');
      })
      .pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send('Download failed.');
  }
});

app.listen(PORT, () => {
  console.log(`ytdl-site running at http://localhost:${PORT}`);
});
