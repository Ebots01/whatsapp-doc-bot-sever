// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(cors()); // Allow Flutter app to talk to this server

// -------------------------------------------------------------
// CONFIGURATION (Set these in your Environment Variables)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // e.g., 'blue_panda_123'
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // From Meta Developers
const SERVER_URL = process.env.SERVER_URL; // e.g., 'https://my-app.vercel.app'

// -------------------------------------------------------------
// IN-MEMORY STORAGE (Temporary List)
// -------------------------------------------------------------
// This list resets when the server sleeps. For permanent history, use a database.
let receivedFiles = []; 

// -------------------------------------------------------------
// 1. WEB UI (The "Good UI" you asked for)
// -------------------------------------------------------------
app.get('/', (req, res) => {
  const fileRows = receivedFiles.map(f => `
    <tr class="hover:bg-gray-50 border-b">
      <td class="px-6 py-4 text-sm text-gray-700">${f.timestamp}</td>
      <td class="px-6 py-4 font-medium text-gray-900 flex items-center gap-2">
        <span class="text-green-600">📄</span> ${f.pathname}
      </td>
      <td class="px-6 py-4 text-sm text-gray-500">${f.mime_type}</td>
      <td class="px-6 py-4">
        <a href="${f.url}" target="_blank" class="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm transition">
          Download
        </a>
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Doc Server</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 font-sans min-h-screen">
      <div class="max-w-5xl mx-auto py-10 px-4">
        <div class="bg-white shadow-xl rounded-2xl overflow-hidden border border-gray-100">
          <div class="bg-[#128C7E] p-8 text-white flex justify-between items-center">
            <div>
              <h1 class="text-3xl font-bold">WhatsApp Documents</h1>
              <p class="text-teal-100 mt-2 opacity-90">Live Receiver & Proxy Server</p>
            </div>
            <div class="bg-white/20 px-4 py-2 rounded-lg backdrop-blur-sm">
              <span class="font-mono font-bold text-2xl">${receivedFiles.length}</span> Files
            </div>
          </div>
          
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="bg-gray-100 text-gray-600 uppercase text-xs tracking-wider">
                  <th class="px-6 py-4 font-semibold">Time Received</th>
                  <th class="px-6 py-4 font-semibold">Filename</th>
                  <th class="px-6 py-4 font-semibold">Type</th>
                  <th class="px-6 py-4 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody>
                ${receivedFiles.length > 0 ? fileRows : 
                  '<tr><td colspan="4" class="p-10 text-center text-gray-400 italic">No documents received yet.<br>Send a PDF to your WhatsApp bot to see it here.</td></tr>'}
              </tbody>
            </table>
          </div>
          
          <div class="bg-gray-50 p-4 text-center text-xs text-gray-400 border-t">
            Server Status: 🟢 Online | Mode: Proxy (No Storage)
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

// -------------------------------------------------------------
// 2. FLUTTER API (List Files)
// -------------------------------------------------------------
app.get('/api/files', (req, res) => {
  // Return the JSON list to Flutter
  res.json(receivedFiles);
});

// -------------------------------------------------------------
// 3. PROXY DOWNLOAD (The "Blob-Free" Magic)
// -------------------------------------------------------------
app.get('/api/proxy/:mediaId', async (req, res) => {
  const mediaId = req.params.mediaId;
  
  try {
    // A. Ask Facebook for the real download URL
    const urlResponse = await axios.get(`https://graph.facebook.com/v17.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });
    
    const actualUrl = urlResponse.data.url;

    // B. Stream the file directly from Facebook to Flutter
    const fileResponse = await axios({
      method: 'get',
      url: actualUrl,
      responseType: 'stream',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
    });

    res.setHeader('Content-Type', urlResponse.data.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="whatsapp_doc.pdf"`);
    
    fileResponse.data.pipe(res);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.status(500).send("Error fetching file from WhatsApp.");
  }
});

// -------------------------------------------------------------
// 4. WHATSAPP WEBHOOK (Receive Messages)
// -------------------------------------------------------------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && 
      req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(400);
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;
  
  // Log incoming webhooks to debug
  // console.log(JSON.stringify(body, null, 2));

  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const msg = body.entry[0].changes[0].value.messages[0];

      if (msg.type === 'document') {
        const doc = msg.document;
        
        // Add to our list
        const newFile = {
          pathname: doc.filename || `doc_${msg.timestamp}.pdf`,
          mime_type: doc.mime_type,
          timestamp: new Date().toLocaleTimeString(),
          // CRITICAL: We create a URL that points to OUR proxy, not Facebook directly
          url: `${SERVER_URL}/api/proxy/${doc.id}`
        };

        receivedFiles.unshift(newFile); 
        console.log(`New File Added: ${newFile.pathname}`);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));