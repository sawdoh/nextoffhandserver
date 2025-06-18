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

// Add rate limiting and connection tracking
const activeTranscribeStreams = new Set();
const MAX_CONCURRENT_STREAMS = 20; // Leave some buffer below AWS limit of 25
const RATE_LIMIT_WINDOW = 1000; // 1 second window
const RATE_LIMIT_MAX = 10; // Max requests per window
const requestTimestamps = [];

// Rate limiting middleware
function rateLimiter(req, res, next) {
  const now = Date.now();
  requestTimestamps.push(now);
  
  // Remove timestamps older than the window
  while (requestTimestamps[0] < now - RATE_LIMIT_WINDOW) {
    requestTimestamps.shift();
  }
  
  if (requestTimestamps.length > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  
  next();
}

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
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Store connected video clients
let videoClients = [];

// Store WebSocket clients
let wsClients = [];

// Add logging utility
const log = {
  info: (message, data = {}) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] INFO: ${message}`, Object.keys(data).length ? data : '');
  },
  error: (message, error = {}) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR: ${message}`, error);
  },
  debug: (message, data = {}) => {
    if (process.env.NODE_ENV === 'development') {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] DEBUG: ${message}`, Object.keys(data).length ? data : '');
    }
  }
};

// Remove express.raw middleware from /stream-audio
app.post('/stream-audio', rateLimiter, (req, res) => {
  console.log('Received audio stream request');
  
  if (activeTranscribeStreams.size >= MAX_CONCURRENT_STREAMS) {
    return res.status(429).json({ error: 'Maximum concurrent streams reached' });
  }
  
  try {
    // Set up AWS Transcribe Streaming
    console.log('Setting up AWS Transcribe streaming...');
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
      AudioStream: (async function* () {
        // Keep the stream open and process chunks as they arrive
        for await (const chunk of req) {
          console.log('Received audio chunk, size:', chunk.length);
          yield { AudioEvent: { AudioChunk: chunk } };
        }
      })(),
    });

    // Set up streaming response
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');
    console.log('Sending audio to AWS Transcribe...');
    
    // Handle the streaming response
    (async () => {
      try {
        const stream = await transcribeClient.send(command);
        activeTranscribeStreams.add(stream);
        
        console.log('Got response from AWS Transcribe');
        
        for await (const event of stream.TranscriptResultStream) {
          console.log('Raw transcript event:', JSON.stringify(event, null, 2));
          if (event.TranscriptEvent) {
            const results = event.TranscriptEvent.Transcript.Results;
            console.log('Transcript results:', JSON.stringify(results, null, 2));
            if (results && results.length > 0) {
              const transcript = results[0].Alternatives[0]?.Transcript;
              if (transcript) {
                console.log('Received transcript:', transcript);
                res.write(JSON.stringify({ transcript }) + '\n');
                wsClients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                    console.log('Sending transcript to WebSocket client:', transcript);
                    client.send(JSON.stringify({ type: 'transcript', transcript }));
                  }
                });
              }
            }
          }
        }
      } catch (error) {
        console.error('Error in transcription stream:', error);
        res.status(500).json({ error: 'Transcription failed' });
      } finally {
        activeTranscribeStreams.delete(stream);
      }
    })();

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected from audio stream');
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
    key: fs.readFileSync('/etc/letsencrypt/live/server.offhand.ai/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/server.offhand.ai/fullchain.pem'),
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
  clientTracking: true,
  perMessageDeflate: false,
});

wss.on('connection', (ws, req) => {
  log.info('New WebSocket connection', { 
    remoteAddress: req.socket.remoteAddress,
    url: req.url 
  });
  
  if (req.url === '/audio-stream') {
    log.info('Audio stream WebSocket connection established');
    
    if (activeTranscribeStreams.size >= MAX_CONCURRENT_STREAMS) {
      log.error('Maximum concurrent streams reached', { 
        current: activeTranscribeStreams.size,
        max: MAX_CONCURRENT_STREAMS 
      });
      ws.send(JSON.stringify({ type: 'error', error: 'Maximum concurrent streams reached' }));
      ws.close();
      return;
    }

    let transcribeStream = null;
    let audioStreamGenerator = null;
    let audioChunksReceived = 0;
    let lastLogTime = Date.now();
    let isInitialized = false;
    
    ws.on('message', async (data) => {
      try {
        audioChunksReceived++;
        const now = Date.now();
        
        // Log audio chunk stats every second
        if (now - lastLogTime >= 1000) {
          log.info('Audio streaming stats', {
            chunksReceived: audioChunksReceived,
            chunkSize: data.length,
            activeStreams: activeTranscribeStreams.size
          });
          audioChunksReceived = 0;
          lastLogTime = now;
        }

        if (!isInitialized) {
          log.info('Starting new transcription stream');
          isInitialized = true;
          
          // Create audio stream generator
          audioStreamGenerator = (async function* () {
            while (true) {
              if (data) {
                log.debug('Sending audio chunk to AWS Transcribe', {
                  chunkSize: data.length
                });
                yield { AudioEvent: { AudioChunk: data } };
              }
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          })();

          // Create AWS Transcribe command
          const command = new StartStreamTranscriptionCommand({
            LanguageCode: 'en-US',
            MediaEncoding: 'pcm',
            MediaSampleRateHertz: 16000,
            AudioStream: audioStreamGenerator,
            EnablePartialResultsStabilization: true,
            PartialResultsStability: 'high',
            ShowSpeakerLabels: false,
            EnableChannelIdentification: false
          });

          log.info('Initiating AWS Transcribe stream');
          transcribeStream = await transcribeClient.send(command);
          activeTranscribeStreams.add(transcribeStream);
          log.info('Transcription stream started', { 
            activeStreams: activeTranscribeStreams.size 
          });
          
          // Process transcription results
          (async () => {
            try {
              log.info('Starting transcription result processing');
              for await (const event of transcribeStream.TranscriptResultStream) {
                log.debug('Received event from AWS Transcribe', {
                  eventType: Object.keys(event)[0]
                });
                
                if (event.TranscriptEvent) {
                  const results = event.TranscriptEvent.Transcript.Results;
                  if (results && results.length > 0) {
                    const transcript = results[0].Alternatives[0]?.Transcript;
                    if (transcript) {
                      log.info('Received transcript', { 
                        transcript,
                        isPartial: results[0].IsPartial
                      });
                      ws.send(JSON.stringify({ type: 'transcript', transcript }));
                    }
                  }
                }
              }
            } catch (error) {
              log.error('Error processing transcription stream', {
                error: error.message,
                code: error.code,
                stack: error.stack
              });
              ws.send(JSON.stringify({ type: 'error', error: 'Transcription processing failed' }));
            }
          })();
        } else {
          // Update the audio data for the generator
          data = data;
        }
      } catch (error) {
        log.error('Error in transcription stream', {
          error: error.message,
          code: error.code,
          stack: error.stack
        });
        ws.send(JSON.stringify({ type: 'error', error: 'Transcription failed' }));
      }
    });

    ws.on('error', (error) => {
      log.error('Audio WebSocket error', {
        error: error.message,
        code: error.code,
        stack: error.stack
      });
      if (transcribeStream) {
        activeTranscribeStreams.delete(transcribeStream);
        transcribeStream = null;
      }
      isInitialized = false;
    });

    ws.on('close', () => {
      log.info('Audio WebSocket connection closed', {
        activeStreams: activeTranscribeStreams.size,
        totalChunksReceived: audioChunksReceived
      });
      if (transcribeStream) {
        activeTranscribeStreams.delete(transcribeStream);
        transcribeStream = null;
      }
      isInitialized = false;
    });
  } else if (req.url === '/') {
    // Handle video/transcription connection
    log.info('Video/transcription WebSocket connection established');
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
  } else {
    ws.close();
  }
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