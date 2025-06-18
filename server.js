const express = require('express');
const app = express();
const httpPort = 3001;
const httpsPort = 3002;
const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
require('dotenv').config();
const https = require('https');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

// Enable CORS with more specific headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

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

// Remove express.raw middleware from /stream-audio
app.post('/stream-audio', (req, res) => {
  try {
    let data = [];
    req.on('data', (chunk) => {
      data.push(chunk);
    });
    req.on('end', async () => {
      const buffer = Buffer.concat(data);
      console.log('Received audio stream request, size:', buffer.length);
      // Forward raw PCM audio to WebSocket clients
      wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'audio' })); // signal audio chunk
          client.send(buffer); // send raw PCM buffer
        }
      });
      // PCM audio buffer from ESP32-S3-EYE
      // Set up AWS Transcribe Streaming
      const command = new StartStreamTranscriptionCommand({
        LanguageCode: 'en-US',
        MediaEncoding: 'pcm',
        MediaSampleRateHertz: 16000,
        AudioStream: (async function* () {
          yield { AudioEvent: { AudioChunk: buffer } };
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
    });
  } catch (err) {
    console.error('Transcribe error:', err);
    res.status(500).send('Transcription failed.');
  }
});

// Endpoint for ESP32-S3-EYE to POST MJPEG stream (no body parser)
app.post('/video-stream', (req, res) => {
  console.log('Received video stream request');
  let data = [];
  req.on('data', (chunk) => {
    data.push(chunk);
  });
  req.on('end', () => {
    const buffer = Buffer.concat(data);
    let sentCount = 0;
    wsClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(buffer);
          sentCount++;
        } catch (err) {
          console.error('Error sending frame to client:', err);
        }
      }
    });
    console.log(`Sent frame to ${sentCount} WebSocket clients. Frame size: ${buffer.length} bytes`);
    res.end('OK');
  });
});

// Endpoint for browsers/clients to GET the MJPEG stream
app.get('/video-stream', (req, res) => {
  console.log('Received video stream GET request');
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

// Add a basic health check endpoint
app.get('/', (req, res) => {
  console.log('Received health check request');
  res.send('Server is running');
});

// Load SSL certificates
let options;
try {
  options = {
    key: fs.readFileSync('./certs/nginx-selfsigned.key'),
    cert: fs.readFileSync('./certs/nginx-selfsigned.crt'),
  };
  console.log('SSL certificates loaded successfully');
} catch (err) {
  console.error('Error loading SSL certificates:', err);
  process.exit(1);
}

// Create both HTTP and HTTPS servers
const httpServer = http.createServer(app);
const httpsServer = https.createServer(options, app);

// Create WebSocket server on HTTPS
const wss = new WebSocket.Server({ 
  server: httpsServer,
  path: '/',
  clientTracking: true,
  perMessageDeflate: false,
});

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);
  wsClients.push(ws);
  
  ws.on('message', (message) => {
    console.log('Received WebSocket message:', message.toString());
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    wsClients = wsClients.filter(client => client !== ws);
  });

  // Send a test message to verify connection
  ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
});

// Error handling for both servers
httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${httpPort} is already in use. Please free up the port or use a different one.`);
  } else {
    console.error('HTTP Server error:', error);
  }
  process.exit(1);
});

httpsServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${httpsPort} is already in use. Please free up the port or use a different one.`);
  } else {
    console.error('HTTPS Server error:', error);
  }
  process.exit(1);
});

// Function to start servers
function startServers() {
  try {
    httpServer.listen(httpPort, '0.0.0.0', () => {
      console.log(`HTTP Server listening at http://0.0.0.0:${httpPort}`);
    });

    httpsServer.listen(httpsPort, '0.0.0.0', () => {
      console.log(`HTTPS Server listening at https://0.0.0.0:${httpsPort}`);
    });
  } catch (error) {
    console.error('Error starting servers:', error);
    process.exit(1);
  }
}

// Start the servers
startServers(); 