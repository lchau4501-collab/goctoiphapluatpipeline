export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOrchestrator(env));
  },
  
  // Also support manual HTTP trigger for testing
  async fetch(request, env) {
    try {
      await runOrchestrator(env);
      return new Response("Orchestrator run triggered successfully!", { status: 200 });
    } catch (err) {
      return new Response("Error: " + err.message, { status: 500 });
    }
  }
};

async function runOrchestrator(env) {
  // 1. Fetch Google Sheet to check completed historical figures (avoid duplicates)
  console.log("Fetching past historical figures from Google Sheets...");
  const sheetData = await fetchGoogleSheet(env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_TOKEN, env.SPREADSHEET_ID);
  const completedFigures = sheetData.map(row => row.historical_figure || row["Historical Figure"]).filter(Boolean);

  // 2. Call Cloudflare Workers AI to generate a new True Crime case and titles with fuzzy duplicate check
  console.log("Generating new True Crime case using Cloudflare AI...");
  let result = null;
  let attempts = 0;
  
  const recentCompleted = completedFigures.slice(-20);
  const avoidFiguresStr = recentCompleted.length > 0 ? recentCompleted.join(", ") : "None";
  
  while (attempts < 4) {
    attempts++;
    console.log(`Generation attempt ${attempts}...`);
    
    const messages = [
      {
        role: "system",
        content: "You are a database generator. You output ONLY valid JSON, with absolutely no markdown formatting, backticks, or extra commentary. Your output must be a single JSON object."
      },
      {
        role: "user",
        content: `Propose 1 famous Vietnamese True Crime case (vụ án có thật tại Việt Nam, đặc biệt là giai đoạn trước năm 1975 hoặc vụ án hình sự nổi tiếng).
Generate a YouTube SEO title for it in Vietnamese in this exact style: 
[Tên vụ án/Nhân vật]: [Tiêu đề phụ kịch tính tạo tò mò] | Vụ Án Có Thật [Địa danh xảy ra vụ án] [Năm xảy ra vụ án]

Avoid these already completed cases: ${avoidFiguresStr}.

You must respond in this exact JSON format:
{"historical_figure": "Name of the case/person", "selected_title": "[Tên vụ án/Nhân vật]: [Tiêu đề phụ kịch tính] | Vụ Án Có Thật [Địa danh] [Năm]"}

Example:
{"historical_figure": "Vụ án Biệt Thự Catinat", "selected_title": "Biệt Thự Catinat: Bữa Tiệc Giáng Sinh Cuối Cùng | Vụ Án Có Thật Sài Gòn 1942"}
`
      }
    ];

    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
        messages,
        max_tokens: 2048
      });
      let responseText = aiResponse.response || aiResponse;
      if (typeof responseText !== 'string') {
        responseText = JSON.stringify(responseText);
      }
      
      const jsonStr = extractFirstJsonObject(responseText);
      if (!jsonStr) {
        console.log("Could not find a valid JSON object in the AI response: " + responseText);
        continue;
      }
      
      const tempResult = JSON.parse(jsonStr);
      const figure = tempResult.historical_figure || "";
      if (!figure) continue;
      
      const figNorm = normalizeText(figure);
      const isDuplicate = completedFigures.some(fig => normalizeText(fig) === figNorm);
      if (isDuplicate) {
        console.log(`Duplicate filtered out: Case "${figure}" is already in completed list.`);
        continue;
      }
      
      result = tempResult;
      break;
    } catch (e) {
      console.log(`Error in attempt ${attempts}: ${e.message}`);
    }
  }
  
  if (!result) {
    throw new Error("Failed to generate a unique True Crime case after 4 attempts.");
  }

  // 4. Append row to ideation GSheet tab with status "idea"
  const newRowId = generateUUID();
  console.log(`Appending new row to ideation sheet. ID: ${newRowId}`);
  await appendSheetRow(
    env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_TOKEN, 
    env.SPREADSHEET_ID, 
    [
      newRowId,
      result.historical_figure,
      result.selected_title,
      "idea",
      new Date().toISOString()
    ],
    "ideation"
  );

  // 5. Trigger GitHub repository dispatch for scripting (Step 2) - COMMENTED OUT for human-in-the-loop approval
  console.log("Skipping automatic GHA trigger. Waiting for manual approval in GSheet.");
  /*
  await triggerGitHubWorkflow(
    "YOUR_GITHUB_TOKEN_HERE", 
    "lchau4501-collab", 
    "goctoiphapluat-step2-scripting", 
    "run-scripting", 
    {
      id: newRowId,
      prompt: `Viết kịch bản chi tiết về vụ án ${result.historical_figure}: ${result.selected_title} theo phong cách kịch bản Góc Tối Pháp Luật.`
    }
  );
  */
}

// Helper: Normalize text by stripping accents, all punctuation/quotes and spaces
function normalizeText(str) {
  if (!str) return "";
  return str.toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/['’‘"“”\-\.,:;!\?_#\*]/g, "") // Remove all punctuation, quotes, hashtags
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

// Helper: Generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Google Sheets API fetch helper
async function fetchGoogleSheet(credsJson, spreadsheetId) {
  // Parsing service account details
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/goctoiphapluat!A1:H100`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet values: ${response.statusText}`);
  }
  
  const data = await response.json();
  const rows = data.values;
  if (!rows || rows.length <= 1) return [];
  
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

// Google Drive API folder creation helper
async function createGoogleDriveFolder(credsJson, parentId, folderName) {
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const url = 'https://www.googleapis.com/drive/v3/files';
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : []
  };
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create GDrive folder: ${response.statusText}`);
  }
  
  const folder = await response.json();
  return `https://drive.google.com/drive/folders/${folder.id}`;
}

// Google Sheets append row helper
async function appendSheetRow(credsJson, spreadsheetId, values, sheetName = "goctoiphapluat") {
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}!A1:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      values: [values]
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to append sheet row: ${response.statusText}`);
  }
}

// GitHub Workflow dispatch helper
async function triggerGitHubWorkflow(token, owner, repo, eventType, payload) {
  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'cloudflare-worker-orchestrator',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: payload
    })
  });
  
  if (!response.ok) {
    throw new Error(`Failed to trigger GitHub workflow: ${response.statusText}`);
  }
}

// Service Account JWT token generator for Cloudflare Worker environment
async function getGoogleAuthToken(creds) {
  const header = b64Escape(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  
  const claimSet = b64Escape(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: exp,
    iat: iat
  }));
  
  const signatureInput = `${header}.${claimSet}`;
  
  // Import the RSA private key in Cloudflare Web Crypto API
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = creds.private_key
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s+/g, "");
    
  const rawKey = base64ToArrayBuffer(pemContents);
  
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    rawKey,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" }
    },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );
  
  const jwt = `${signatureInput}.${arrayBufferToBase64Url(signature)}`;
  
  // Call token exchange endpoint
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.statusText}`);
  }
  
  const result = await response.json();
  return result.access_token;
}

function b64Escape(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToArrayBuffer(b64) {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return b64Escape(binary);
}

function extractFirstJsonObject(str) {
  const start = str.indexOf('{');
  if (start === -1) return null;
  
  let braceCount = 0;
  let inString = false;
  let escape = false;
  
  for (let i = start; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return str.substring(start, i + 1);
        }
      }
    }
  }
  return null;
}
