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
  const credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_TOKEN;
  
  // 1. Fetch current completed cases from master tab
  console.log("Fetching past historical figures from Google Sheets...");
  let completedRows = [];
  try {
    completedRows = await fetchGoogleSheetRange(credentials, env.SPREADSHEET_ID, "goctoiphapluat!B2:B2000");
  } catch (e) {
    console.log("Warning: Failed to fetch completed figures. Proceeding with empty list.");
  }
  const completedFigures = completedRows.map(row => row[0] ? row[0].toString().trim() : "").filter(Boolean);

  // 2. Fetch keyword from 'ideation!C1'
  let keyword = "";
  try {
    const ideationC1 = await fetchGoogleSheetRange(credentials, env.SPREADSHEET_ID, "ideation!C1");
    if (ideationC1 && ideationC1[0] && ideationC1[0][0]) {
      keyword = ideationC1[0][0].toString().trim();
    }
  } catch (e) {
    console.log("Warning: Failed to fetch keyword from C1. Proceeding with empty keyword.");
  }
  console.log(`Keyword from C1: "${keyword}"`);

  // Fetch proposed figures from 'ideation' tab to avoid duplicates
  let ideationRows = [];
  try {
    ideationRows = await fetchGoogleSheetRange(credentials, env.SPREADSHEET_ID, "ideation!B3:B2000");
  } catch (e) {
    console.log("Warning: Failed to fetch ideation figures. Proceeding with empty list.");
  }
  const proposedFigures = ideationRows.map(row => row[0] ? row[0].toString().trim() : "").filter(Boolean);
  
  const allAvoidFigures = [...completedFigures, ...proposedFigures];
  const recentCompleted = allAvoidFigures.slice(-30);
  const avoidFiguresStr = recentCompleted.length > 0 ? recentCompleted.join(", ") : "None";

  // 3. Call Cloudflare Workers AI to generate 10-15 different True Crime cases
  console.log("Generating 10-15 different True Crime cases using Cloudflare AI...");
  let result = null;
  let attempts = 0;
  
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
        content: `Propose a list of 10 to 15 DIFFERENT famous, SPECIFIC Vietnamese True Crime cases (vụ án hình sự CỤ THỂ có thật tại Việt Nam, đặc biệt là giai đoạn trước năm 1975 hoặc vụ án hình sự nổi tiếng) related to keyword: "${keyword}". If the keyword is blank or too generic, you must still propose SPECIFIC, concrete historical cases.

CRITICAL CONSTRAINTS:
- The proposed cases MUST be real historical events with SPECIFIC names of victims, criminals, locations, or dates.
- The cases MUST be homicide/murder cases or political assassinations (các vụ án mạng, giết người, hoặc ám sát chính trị cụ thể).
- ABSOLUTELY EXCLUDE any war-related massacres, battlefield deaths, or military operations (tuyệt đối không lấy các vụ thảm sát do chiến tranh hoặc sự kiện quân sự).
- ABSOLUTELY FORBIDDEN to use vague placeholders or generic templates such as: "Một người đàn ông giết một số người bằng cây gậy", "Một sát nhân sát hại một phụ nữ ở biệt thự sang trọng", "Sử dụng cây gậy", "Sử dụng dao sắc". Everything must be a real historical true crime case with concrete facts.
- The "brief_details" MUST contain clear, specific, and sensational details about what actually happened in that specific case (e.g. details of the crime, the criminal's method, or the victim's identity) without being excessively graphic/gory (không miêu tả máu me rùng rợn gây ám ảnh để tránh kích hoạt bộ lọc an toàn, nhưng phải cụ thể và lôi cuốn).
- Strictly focus on civilian criminal/true crime cases (trộm cướp, sát nhân, án mạng biệt thự, lừa đảo, gián điệp hình sự...).
- ABSOLUTELY DO NOT propose any cases related to political, revolutionary, or historical figures/war heroes of the Communist Party of Vietnam or the Vietnamese resistance wars (such as Đặng Thùy Trâm, Nguyễn Văn Trỗi, Võ Thị Sáu, Lý Tự Trọng, Nguyễn Văn Cừ, etc.).

Each proposed case must contain:
1. "historical_figure": Short name of the case/person (Tên ngắn gọn của vụ án hoặc thủ phạm)
2. "selected_title": YouTube SEO title in this exact style: [historical_figure]: [dramatic subtitle] | Vụ Án Có Thật [Location] [Year]
3. "brief_details": Very specific and detailed description of the real crime (chi tiết có thật và giật gân rõ ràng, cụ thể, tuyệt đối không viết chung chung)

Avoid these already completed or proposed cases: ${avoidFiguresStr}.

You must respond in this exact JSON format:
{
  "ideas": [
    {
      "historical_figure": "Name of the case",
      "selected_title": "Name: Subtitle | Vụ Án Có Thật Location Year",
      "brief_details": "Details here"
    }
  ]
}

Examples of the expected level of details:
{
  "ideas": [
    {
      "historical_figure": "Vụ án vũ nữ Cẩm Nhung",
      "selected_title": "Vũ Nữ Cẩm Nhung: Vụ Đánh Ghen Bằng Axit Chấn Động | Vụ Án Có Thật Sài Gòn 1963",
      "brief_details": "Vụ đánh ghen tàn khốc nhắm vào vũ nữ nổi tiếng Cẩm Nhung do phu nhân của trung tá quân đội Trần Ngọc Thức thuê giang hồ thực hiện. Nạn nhân bị tạt axit Sunfuric đậm đặc ngay trước ngõ nhà, hủy hoại hoàn toàn khuôn mặt xinh đẹp."
    },
    {
      "historical_figure": "Vụ án tiệm vàng Kim Sinh",
      "selected_title": "Tiệm Vàng Kim Sinh: Thảm Án Đêm Mưa Lạnh | Vụ Án Có Thật Hà Nội 1999",
      "brief_details": "Kẻ thủ ác Nguyễn Minh Châu đột nhập vào tiệm vàng Kim Sinh trên đường Tây Sơn vào nửa đêm. Hắn dùng dao và thanh sắt hạ sát dã man cả gia đình chủ tiệm gồm 4 người để cướp đi hàng chục lượng vàng rồi bỏ trốn."
    },
    {
      "historical_figure": "Biệt thự Catinat Sài Gòn 1942",
      "selected_title": "Biệt Thự Catinat: Bữa Tiệc Giáng Sinh Cuối Cùng | Vụ Án Có Thật Sài Gòn 1942",
      "brief_details": "Vụ sát hại góa phụ giàu có người Pháp Marie-Louise tại biệt thự sang trọng trên đường Catinat vào đêm Noel. Thủ phạm là tình nhân trẻ của bà, kẻ đã dàn dựng vụ cướp để chiếm đoạt số trang sức đắt tiền."
    }
  ]
}
`
      }
    ];

    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
        messages,
        max_tokens: 4096
      });
      let responseText = aiResponse.response || aiResponse;
      if (typeof responseText !== 'string') {
        responseText = JSON.stringify(responseText);
      }
      
      const jsonStr = extractFirstJsonObject(responseText);
      if (!jsonStr) {
        console.log("Could not find a valid JSON object in the AI response.");
        continue;
      }
      
      const tempResult = JSON.parse(jsonStr);
      if (tempResult.ideas && Array.isArray(tempResult.ideas) && tempResult.ideas.length >= 10) {
        // Filter out duplicates
        const uniqueIdeas = [];
        for (const idea of tempResult.ideas) {
          const figure = idea.historical_figure || "";
          if (!figure) continue;
          
          const figNorm = normalizeText(figure);
          const isDuplicate = allAvoidFigures.some(fig => normalizeText(fig) === figNorm);
          if (!isDuplicate) {
            uniqueIdeas.push(idea);
          }
        }
        
        if (uniqueIdeas.length >= 5) { // Ensure we got a good number of unique ideas
          tempResult.ideas = uniqueIdeas;
          result = tempResult;
          break;
        } else {
          console.log("Too many duplicate cases generated. Retrying...");
        }
      } else {
        console.log("AI returned less than 10 ideas. Retrying...");
      }
    } catch (e) {
      console.log(`Error in attempt ${attempts}: ${e.message}`);
    }
  }
  
  if (!result || !result.ideas || result.ideas.length === 0) {
    throw new Error("Failed to generate unique True Crime cases after 4 attempts.");
  }

  // 4. Find the first empty row starting from row 3 in 'ideation' tab
  let ideationFullRows = [];
  try {
    ideationFullRows = await fetchGoogleSheetRange(credentials, env.SPREADSHEET_ID, "ideation!A3:F2000");
  } catch (e) {
    console.log("Warning: Failed to fetch ideation rows. Proceeding with empty list.");
  }
  
  let firstEmptyRowIdx = 3;
  for (let i = 0; i < ideationFullRows.length; i++) {
    const row = ideationFullRows[i];
    const hasData = row.some(cell => cell !== null && cell !== "");
    if (!hasData) {
      firstEmptyRowIdx = i + 3;
      break;
    }
  }
  if (firstEmptyRowIdx === 3 && ideationFullRows.length > 0) {
    firstEmptyRowIdx = ideationFullRows.length + 3;
  }
  
  console.log(`First empty row in ideation tab found at: ${firstEmptyRowIdx}`);

  // 5. Append generated ideas to 'ideation' tab
  const updates = [];
  const startRow = firstEmptyRowIdx;
  const maxTargetRow = startRow + result.ideas.length;
  
  await ensureSheetRows(credentials, env.SPREADSHEET_ID, "ideation", maxTargetRow);
  
  for (let i = 0; i < result.ideas.length; i++) {
    const idea = result.ideas[i];
    const currentRowIdx = startRow + i;
    
    updates.push({
      range: `ideation!A${currentRowIdx}:F${currentRowIdx}`,
      values: [[
        generateUUID(),
        idea.historical_figure,
        idea.selected_title,
        idea.brief_details,
        "idea",
        new Date().toISOString()
      ]]
    });
  }
  
  console.log(`Sending batch update to sheet for ${updates.length} rows...`);
  await batchUpdateSheet(credentials, env.SPREADSHEET_ID, updates);
  console.log("Successfully wrote generated ideas to 'ideation' tab!");
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

// Google Sheets API fetch range helper
async function fetchGoogleSheetRange(credsJson, spreadsheetId, range) {
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet range ${range}: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.values || [];
}

// Google Sheets API fetch helper (legacy compatibility)
async function fetchGoogleSheet(credsJson, spreadsheetId) {
  return await fetchGoogleSheetRange(credsJson, spreadsheetId, "goctoiphapluat!A1:H100");
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

// Helper: Batch update values in Google Sheets
async function batchUpdateSheet(credsJson, spreadsheetId, updates) {
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
  const payload = {
    valueInputOption: "USER_ENTERED",
    data: updates
  };
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to batch update sheet: ${response.statusText}. Response: ${errText}`);
  }
}

// Helper: Ensure Sheet has enough rows
async function ensureSheetRows(credsJson, spreadsheetId, sheetName, requiredRows) {
  const creds = typeof credsJson === 'string' ? JSON.parse(credsJson) : credsJson;
  const token = await getGoogleAuthToken(creds);
  
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?includeGridData=false`;
  const metaResponse = await fetch(metaUrl, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!metaResponse.ok) {
    throw new Error(`Failed to fetch spreadsheet metadata: ${metaResponse.statusText}`);
  }
  const metaData = await metaResponse.json();
  
  const targetSheet = metaData.sheets.find(s => s.properties.title === sheetName);
  if (!targetSheet) {
    throw new Error(`Sheet with title "${sheetName}" not found.`);
  }
  
  const sheetId = targetSheet.properties.sheetId;
  const currentRowCount = targetSheet.properties.gridProperties.rowCount;
  
  if (currentRowCount < requiredRows) {
    const addRowsCount = requiredRows - currentRowCount;
    console.log(`Sheet "${sheetName}" row count (${currentRowCount}) is less than required (${requiredRows}). Appending ${addRowsCount} rows...`);
    
    const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const updateResponse = await fetch(updateUrl, {
      method: "POST",
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            appendDimension: {
              sheetId: sheetId,
              dimension: "ROWS",
              length: addRowsCount
            }
          }
        ]
      })
    });
    
    if (!updateResponse.ok) {
      const errText = await updateResponse.text();
      throw new Error(`Failed to append rows to sheet: ${errText}`);
    }
    console.log(`Successfully appended ${addRowsCount} rows to sheet "${sheetName}".`);
  }
}

// GitHub Workflow dispatch helper (legacy compatibility)
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
