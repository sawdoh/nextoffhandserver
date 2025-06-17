# NextOffhand Audio Streaming Server

This Node.js server accepts streaming PCM audio from an ESP32-S3-EYE device and forwards it to AWS Transcribe for real-time transcription.

## Features
- Accepts raw PCM audio via HTTP POST at `/stream-audio`
- Designed for integration with AWS Transcribe Streaming

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   node server.js
   ```
3. Send PCM audio (L16, 16kHz recommended) to `http://<server-ip>:3001/stream-audio`

## To Do
- Integrate AWS Transcribe Streaming
- Stream transcription results back to client 