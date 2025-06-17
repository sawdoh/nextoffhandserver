const express = require('express');
const app = express();
const port = 3001;
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');

// Middleware to handle raw PCM audio data
app.use(express.raw({ type: 'audio/L16', limit: '10mb' }));

// AWS credentials and region from environment variables
const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Store connected video clients
let videoClients = [];

// Store WebSocket clients
let wsClients = [];

// Streaming endpoint for ESP32-S3-EYE
app.post('/stream-audio', async (req, res) => {
  try {
    // PCM audio buffer from ESP32-S3-EYE
    const audioStream = req;

    // Set up AWS Transcribe Streaming
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          yield { AudioEvent: { AudioChunk: chunk } };
        }
      })(),
    });

    // Pipe transcription results back to client
    res.setHeader('Content-Type', 'application/json');
    const response = await transcribeClient.send(command);
    for await (const event of response.TranscriptResultStream) {
      if (event.TranscriptEvent) {
        const results = event.TranscriptEvent.Transcript.Results;
        if (results && results.length > 0) {
          const transcript = results[0].Alternatives[0]?.Transcript;
          if (transcript) {
            res.write(JSON.stringify({ transcript }) + '\n');
            wsClients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'transcript', transcript }));
              }
            });
          }
        }
      }
    }
    res.end();
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).send('Transcription failed.');
  }
});

// Endpoint for ESP32-S3-EYE to POST MJPEG stream
app.post('/video-stream', (req, res) => {
  // Broadcast incoming MJPEG data to all connected clients
  req.on('data', (chunk) => {
    videoClients.forEach(client => {
      client.write(chunk);
    });
    wsClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(chunk);
      }
    });
  });
  req.on('end', () => {
    res.end('Stream ended');
  });
});

// Endpoint for browsers/clients to GET the MJPEG stream
app.get('/video-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache',
    'Connection': 'close',
    'Pragma': 'no-cache',
  });
  videoClients.push(res);
  req.on('close', () => {
    videoClients = videoClients.filter(client => client !== res);
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  wsClients.push(ws);
  ws.on('close', () => {
    wsClients = wsClients.filter(client => client !== ws);
  });
});

server.listen(port, () => {
  console.log(`Audio streaming server listening at http://localhost:${port}`);
}); 