# /// script
# dependencies = [
#   "python-dotenv",
#   "requests",
# ]
# ///

import os
import sys
import json
import time
import logging
import random
import re
import argparse
from typing import List, Dict, Any
from dotenv import load_dotenv
import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("goctoiphapluat_generation.log", encoding="utf-8")
    ]
)
logger = logging.getLogger("GocToiPhapLuat")

# Load environment variables
load_dotenv()

STATE_FILE = "goctoiphapluat_state.json"
OUTPUT_FILE = "goctoiphapluat_output.txt"
CONFIG_FILE = "api_config.json"

class APIClientManager:
    """Manages custom endpoints, API keys, and handles automatic rotation & fallback."""
    def __init__(self):
        self.endpoints: List[Dict[str, Any]] = []
        self.current_index = 0
        self.load_configurations()

    def load_configurations(self):
        """Loads endpoints from api_config.json, falling back to .env variables."""
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "endpoints" in data and isinstance(data["endpoints"], list):
                        for ep in data["endpoints"]:
                            if ep.get("api_key") and ep.get("type") in ["gemini", "openai-compatible"]:
                                self.endpoints.append({
                                    "type": ep["type"],
                                    "api_key": ep["api_key"],
                                    "model": ep.get("model", "gemini-2.5-flash"),
                                    "base_url": ep.get("base_url", "https://generativelanguage.googleapis.com")
                                })
                if self.endpoints:
                    logger.info(f"Loaded {len(self.endpoints)} endpoints from {CONFIG_FILE}.")
                    return
            except Exception as e:
                logger.warning(f"Failed to read {CONFIG_FILE}: {e}. Falling back to .env")

        # Fallback to .env configuration
        gemini_keys_str = os.environ.get("GEMINI_API_KEYS", "")
        if gemini_keys_str:
            keys = [k.strip() for k in gemini_keys_str.split(",") if k.strip()]
            for k in keys:
                self.endpoints.append({
                    "type": "gemini",
                    "api_key": k,
                    "model": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                    "base_url": "https://generativelanguage.googleapis.com"
                })

        custom_endpoints_str = os.environ.get("CUSTOM_ENDPOINTS", "")
        if custom_endpoints_str:
            endpoints_list = [ep.strip() for ep in custom_endpoints_str.split(",") if ep.strip()]
            for ep in endpoints_list:
                parts = ep.split("|")
                if len(parts) >= 2:
                    base_url = parts[0].strip()
                    api_key = parts[1].strip()
                    model = parts[2].strip() if len(parts) > 2 else "google/gemini-2.5-flash"
                    self.endpoints.append({
                        "type": "openai-compatible",
                        "api_key": api_key,
                        "base_url": base_url,
                        "model": model
                    })

        single_key = os.environ.get("GEMINI_API_KEY", "")
        if not self.endpoints and single_key:
            self.endpoints.append({
                "type": "gemini",
                "api_key": single_key,
                "model": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                "base_url": "https://generativelanguage.googleapis.com"
            })

        if not self.endpoints:
            # Revert to config.json values from ainovel-cli as final fallback
            if os.path.exists("config.json"):
                try:
                    with open("config.json", "r") as f:
                        conf = json.load(f)
                        p_name = conf.get("provider")
                        p_info = conf.get("providers", {}).get(p_name, {})
                        if p_info.get("api_key"):
                            self.endpoints.append({
                                "type": "openai-compatible" if p_info.get("type") == "openai" or p_name == "n9router" else "gemini",
                                "api_key": p_info.get("api_key"),
                                "model": conf.get("model", "coding"),
                                "base_url": p_info.get("base_url")
                            })
                except Exception as e:
                    logger.warning(f"Failed to load config.json fallback: {e}")

        if not self.endpoints:
            logger.error("No valid API endpoints configured.")
            sys.exit(1)
            
        logger.info(f"Loaded {len(self.endpoints)} endpoints.")

    def get_current_endpoint(self) -> Dict[str, Any]:
        if not self.endpoints:
            raise ValueError("No endpoints configured.")
        return self.endpoints[self.current_index]

    def rotate_endpoint(self):
        if len(self.endpoints) <= 1:
            return
        self.current_index = (self.current_index + 1) % len(self.endpoints)
        ep = self.get_current_endpoint()
        masked_key = ep['api_key'][:6] + "..." + ep['api_key'][-4:] if len(ep['api_key']) > 10 else "***"
        logger.info(f"Rotating to next endpoint index {self.current_index}: Model={ep['model']}")

    def generate_content(self, prompt: str, response_mime_type: str = None) -> str:
        attempts = 0
        max_attempts = len(self.endpoints) * 2

        while attempts < max_attempts:
            ep = self.get_current_endpoint()
            url = ""
            headers = {"Content-Type": "application/json"}
            payload = {}

            try:
                if ep["type"] == "gemini":
                    model_name = ep["model"]
                    base_url = ep["base_url"].rstrip("/")
                    url = f"{base_url}/v1beta/models/{model_name}:generateContent?key={ep['api_key']}"
                    
                    config = {"temperature": 0.75}
                    if response_mime_type:
                        config["responseMimeType"] = response_mime_type

                    payload = {
                        "contents": [{
                            "parts": [{"text": prompt}]
                        }],
                        "generationConfig": config
                    }
                    response = requests.post(url, headers=headers, json=payload, timeout=120)
                else:
                    base_url = ep["base_url"].rstrip("/")
                    url = f"{base_url}/chat/completions"
                    headers["Authorization"] = f"Bearer {ep['api_key']}"
                    
                    payload = {
                        "model": ep["model"],
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.75
                    }
                    if response_mime_type == "application/json":
                        payload["response_format"] = {"type": "json_object"}
                        
                    response = requests.post(url, headers=headers, json=payload, timeout=120)

                if response.status_code == 200:
                    data = response.json()
                    if ep["type"] == "gemini":
                        return data["candidates"][0]["content"]["parts"][0]["text"]
                    else:
                        return data["choices"][0]["message"]["content"]
                else:
                    logger.warning(f"Endpoint returned status {response.status_code}. Response: {response.text}")
                    if response.status_code in [429, 500, 502, 503, 504]:
                        self.rotate_endpoint()
                    else:
                        response.raise_for_status()

            except Exception as e:
                logger.error(f"Request failed on endpoint {self.current_index}: {e}")
                self.rotate_endpoint()

            attempts += 1
            time.sleep(2)

        raise RuntimeError("All configured API endpoints failed.")

# Initialize global API manager
client_manager = APIClientManager()

def clean_text(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline:].strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text

def count_words(text: str) -> int:
    return len(text.split())

def load_state() -> Dict[str, Any]:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                logger.info("Loaded existing generation state. Resuming...")
                return state
        except Exception as e:
            logger.warning(f"Failed to read state file: {e}. Starting fresh.")
    return {
        "topic": "",
        "title": "",
        "outline": [],
        "sections": {},
        "teaser": "",
        "video_package": "",
        "completed": False
    }

def save_state(state: Dict[str, Any]):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to save state file: {e}")

def run_phase_0(state: Dict[str, Any], figure: str, title: str):
    logger.info(f"Starting Phase 0: Outline Generation for {figure} - {title}...")
    
    prompt = f"""
Bạn là biên kịch trưởng cho kênh YouTube "Góc Tối Pháp Luật", chuyên xây dựng kịch bản True Crime Việt Nam trầm ấm, sâu sắc, nhân văn theo phong cách kể chuyện Nguyễn Ngọc Ngạn.
Chúng ta đang viết một kịch bản phim tài liệu vụ án chi tiết về:
Vụ án/Nhân vật chính: {figure}
Tiêu đề video: {title}

Hãy tạo đề cương chi tiết gồm đúng 6 phần tương ứng với tiến trình câu chuyện:
- Phần 1: Mở đầu & Cảnh báo (Giới thiệu địa danh, không khí và cảnh báo bằng tiếng Anh).
- Phần 2: Backstory (Bối cảnh gia đình, xã hội của nạn nhân/hung thủ).
- Phần 3: The Crime (Chi tiết vụ án diễn ra, hiện trường gián tiếp).
- Phần 4: Investigation (Quá trình điều tra, truy tìm manh mối).
- Phần 5: Breakthrough & Climax (Nút thắt tháo gỡ, bắt giữ, phiên tòa xét xử).
- Phần 6: Reflection & Outro (Chiêm nghiệm nhân văn và lời kêu gọi đăng ký kênh).

Trả về kết quả dưới dạng JSON có cấu trúc chính xác sau:
{{
  "outline": [
    {{
      "section_number": 1,
      "title": "Tiêu đề phần 1 (Tối đa 8 từ)",
      "teaser": "Tóm tắt nội dung chính của phần này"
    }},
    ... (đúng 6 phần)
  ]
}}
"""
    try:
        response_text = client_manager.generate_content(prompt, response_mime_type="application/json")
        raw_text = clean_text(response_text)
        data = json.loads(raw_text)
        
        state["topic"] = figure
        state["title"] = title
        state["outline"] = data["outline"]
        
        logger.info(f"Selected Case: {state['topic']}")
        logger.info(f"Selected Title: {state['title']}")
        logger.info("Successfully generated 6-part outline.")
        save_state(state)
        
    except Exception as e:
        logger.error(f"Failed in Phase 0: {e}")
        sys.exit(1)

def generate_section(state: Dict[str, Any], sec_num: int) -> str:
    topic = state["topic"]
    title = state["title"]
    outline_item = state["outline"][sec_num - 1]
    sec_title = outline_item["title"]
    sec_teaser = outline_item["teaser"]
    
    logger.info(f"Generating Section {sec_num}/6: '{sec_title}'...")

    # Define word counts and instructions based on section
    targets = {
        1: {"target": 650, "min": 550},
        2: {"target": 1500, "min": 1300},
        3: {"target": 1500, "min": 1300},
        4: {"target": 1800, "min": 1600},
        5: {"target": 1800, "min": 1600},
        6: {"target": 750, "min": 650}
    }
    
    word_info = targets[sec_num]
    
    special_instruction = ""
    if sec_num == 1:
        special_instruction = """
Bạn bắt buộc phải mở đầu phần này bằng lời cảnh báo bằng tiếng Anh sau đây (khoảng 50-70 từ):
"Before we delve deeper into the events that transpired, we wish to advise that this documentary recounts a real crime with details that some viewers may find distressing. Our intention is to explore this case with the utmost respect for all involved, particularly the memory of the victims."
Sau đó, viết tiếp phần mở đầu dẫn dắt câu chuyện bằng tiếng Việt.
"""
    elif sec_num > 1:
        prev_section_text = state["sections"][str(sec_num - 1)]
        prev_words = prev_section_text.split()
        context_words = prev_words[-200:] if len(prev_words) > 200 else prev_words
        prev_context = " ".join(context_words)
        
        special_instruction = f"""
Để đảm bảo mạch kể chuyện liên tục và mượt mà, đây là đoạn kết của phần trước đó:
"... {prev_context}"

Hãy tiếp tục kể câu chuyện ngay từ điểm này. Tuyệt đối KHÔNG viết lời mở đầu mới, KHÔNG tóm tắt lại ý cũ, không dùng tiêu đề, chỉ viết tiếp câu chuyện dưới dạng văn xuôi.
"""

    if sec_num == 6:
        taglines = [
            "Chúng tôi kể – không để lên án, mà để giữ lại ký ức.",
            "Chúng tôi kể – để công lý bớt lạnh, và ký ức bớt mờ.",
            "Chúng tôi kể – để những đêm ấy không chìm vào quên lãng."
        ]
        chosen_tagline = random.choice(taglines)
        special_instruction += f"""
Ở cuối phần này, sau khi chiêm nghiệm nhân văn về vụ án, kêu gọi đăng ký kênh Góc Tối Pháp Luật, bạn bắt buộc phải kết thúc toàn bộ văn bản bằng câu tagline chính xác sau đây trên một dòng riêng biệt:
"{chosen_tagline}"
"""

    prompt = f"""
Bạn là chuyên gia xây dựng kịch bản YouTube True Crime và người kể chuyện theo phong cách Nguyễn Ngọc Ngạn với giọng văn trầm ấm, sâu sắc, nhân văn của miền Nam Việt Nam trước năm 1975.
Hãy viết phần {sec_num} của kịch bản phim tài liệu vụ án.

Vụ án: {topic}
Tiêu đề: {title}
Nội dung phần này: {sec_title} - {sec_teaser}

{special_instruction}

Quy tắc viết bắt buộc:
1. Ngôn ngữ: Tiếng Việt (sử dụng chất giọng Nam Bộ / Sài Gòn xưa ấm áp, Noir, thong thả).
2. Kiểm chứng lịch sử: Sử dụng địa danh cổ, năm xảy ra vụ án, luật pháp chính xác thời bấy giờ.
3. Sử dụng các tên gọi phiên âm Hán-Việt cổ khi đề cập quốc gia lần đầu (ví dụ: Trung Hoa, Nhật Bổn, Phi Luật Tân, Tân Gia Ba, Hoa Kỳ, Anh Quốc, Pháp Quốc).
4. Văn phong & Nhịp điệu: Trầm ấm, Noir, đi sâu vào thế giới nội tâm và vùng xám đạo đức, tả cảnh - tả tâm - tả ánh sáng và âm thanh. Không tả cảnh máu me bạo lực trực diện.
5. Từ ngữ cổ điển: Sử dụng thuật ngữ tư pháp xưa và danh từ đặc trưng của miền Nam/Sài Gòn trước 1975 (trạng sư, biện lý, phòng nhì, thầy thông, xe thổ mộ...).
6. Không dùng chữ số (0-9): Tất cả các số, năm (1975 -> một ngàn chín trăm bảy mươi lăm), ngày tháng, số thập phân phải được viết hoàn toàn thành chữ tiếng Việt.
7. CẤM HOÀN TOÀN: Tiêu đề phụ, dấu `#`, `##`, đánh số phân đoạn như "Chương X" hay "Phần Y". Không dùng gạch đầu dòng hay danh sách.
8. CẤM Hội thoại trực tiếp (No Direct Dialogue): Tất cả cuộc đối thoại phải được kể gián tiếp thông qua lời độc thoại duy nhất của người dẫn chuyện. Không dùng dấu ngoặc kép hay gạch đầu dòng để dẫn lời thoại nhân vật.
9. Cấm POV nạn nhân đã tử vong.
10. KHÔNG sử dụng các cụm từ cấm sau: "một cách nào đó", "đáng chú ý là", "không biết vì sao", "cảm xúc ngổn ngang", "thời tiết thay đổi".
11. Số từ yêu cầu cho phần {sec_num} này là ít nhất {word_info['target']} từ tiếng Việt. Hãy đặc tả chi tiết giác quan, bối cảnh lịch sử, tâm lý nhân vật để đạt đủ độ dài.

Chỉ xuất ra văn xuôi sạch để đọc Voiceover trực tiếp.
"""

    try:
        response_text = client_manager.generate_content(prompt)
        text = clean_text(response_text)
        word_count = count_words(text)
        logger.info(f"Generated initial Section {sec_num}: {word_count} từ.")
        
        # Expansion loop
        attempt = 1
        while word_count < word_info["min"] and attempt <= 3:
            logger.warning(f"Section {sec_num} word count ({word_count}) is below {word_info['min']} words. Expanding (Attempt {attempt})...")
            
            expand_prompt = f"""
Đoạn văn sau đây dài {word_count} từ, chưa đạt yêu cầu tối thiểu là {word_info['min']} từ.
Hãy viết lại đoạn văn này và mở rộng nó lên ít nhất {word_info['target']} từ bằng cách bổ sung thêm đặc tả bối cảnh xã hội, tâm lý nhân vật, âm thanh xung quanh, chi tiết điều tra gián tiếp và cảm xúc nhân văn.
Đảm bảo giữ nguyên văn phong Nam Bộ xưa trầm ấm, kể chuyện gián tiếp và không dùng chữ số hay tiêu đề.

Đoạn văn hiện tại:
---
{text}
---

Hãy trả về toàn bộ đoạn văn đã được mở rộng.
"""
            response_text = client_manager.generate_content(expand_prompt)
            text = clean_text(response_text)
            word_count = count_words(text)
            logger.info(f"Expansion attempt {attempt} completed: {word_count} từ.")
            attempt += 1
            
        return text

    except Exception as e:
        logger.error(f"Failed to generate Section {sec_num}: {e}")
        raise e

def run_phase_3(state: Dict[str, Any]):
    logger.info("Starting Phase 3: YouTube Shorts Teaser Script...")
    
    prompt = f"""
Dựa trên vụ án: {state['topic']}
Tiêu đề: {state['title']}

Hãy viết kịch bản teaser cho YouTube Shorts ngắn từ 150-250 từ bằng tiếng Việt.
Văn phong giật gân, cuốn hút nhưng trầm ấm đúng phong cách Góc Tối Pháp Luật.
Cuối kịch bản Shorts bắt buộc phải kết thúc bằng câu chính xác sau:
"Xem câu chuyện đầy đủ ngay trên kênh GÓC TỐI PHÁP LUẬT."
"""
    try:
        response_text = client_manager.generate_content(prompt)
        state["teaser"] = clean_text(response_text)
        logger.info("Successfully generated Shorts Teaser script.")
        save_state(state)
    except Exception as e:
        logger.error(f"Failed in Phase 3: {e}")
        sys.exit(1)

def run_phase_4(state: Dict[str, Any]):
    logger.info("Starting Phase 4: Video Package...")
    
    prompt = f"""
Dựa trên vụ án: {state['topic']}
Tiêu đề: {state['title']}

Hãy tạo bộ thông tin mô tả chi tiết của video YouTube:
1. Mô tả video dài 250-350 từ: Giới thiệu vụ án, gợi mở tình tiết hấp dẫn, đậm chất tự sự và nhân văn.
   Kết thúc mô tả bắt buộc bằng câu: "Đăng ký kênh GÓC TỐI PHÁP LUẬT để nghe thêm những vụ án hình sự trầm ấm, noir, nhân văn."
2. Hashtags video: Phải bao gồm "#GocToiPhapLuat #vietnametruecrime #bedtimestory #vuanhinhsu" cùng với 5-8 thẻ liên quan tới vụ án cụ thể này.
3. Mô tả ngắn cho Shorts (1-2 dòng), kết thúc bằng: "Xem câu chuyện đầy đủ ngay trên kênh GÓC TỐI PHÁP LUẬT."
4. Kêu gọi hành động (CTA): "Hãy nhấn Thích, Đăng ký và bật chuông thông báo 🔔 để không bỏ lỡ các kỳ án tiếp theo."
5. Hashtags cho Shorts: "#GocToiPhapLuat #vietnametruecrime #vuan #shorts #youtubeshorts"
"""
    try:
        response_text = client_manager.generate_content(prompt)
        state["video_package"] = clean_text(response_text)
        logger.info("Successfully generated YouTube Video Package.")
        save_state(state)
    except Exception as e:
        logger.error(f"Failed in Phase 4: {e}")
        sys.exit(1)

def compile_final_output(state: Dict[str, Any]):
    logger.info(f"Compiling final script into {OUTPUT_FILE}...")
    try:
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            f.write(f"⚖️ YOUTUBE CHANNEL: GÓC TỐI PHÁP LUẬT\n")
            f.write(f"📌 VỤ ÁN: {state['topic']}\n")
            f.write(f"🎬 SELECTED TITLE: {state['title']}\n\n")
            
            f.write("="*40 + "\n")
            f.write("PHASE 0: ĐỀ CƯƠNG KỊCH BẢN\n")
            f.write("="*40 + "\n")
            for item in state["outline"]:
                f.write(f"Phần {item['section_number']}: {item['title']}\n")
                f.write(f"Tóm tắt: {item['teaser']}\n\n")
            
            f.write("="*40 + "\n")
            f.write("PHASE 2: KỊCH BẢN VOICEover SẠCH (ĐỌC LIỀN MẠCH)\n")
            f.write("="*40 + "\n\n")
            
            for i in range(1, 7):
                f.write(state["sections"][str(i)])
                f.write("\n\n")
                if i < 6:
                    f.write(".........\n\n")
            
            f.write("="*40 + "\n")
            f.write("PHASE 3: KỊCH BẢN YOUTUBE SHORTS TEASER\n")
            f.write("="*40 + "\n\n")
            f.write(state["teaser"])
            f.write("\n\n")
            
            f.write("="*40 + "\n")
            f.write("PHASE 4: BỘ THÔNG TIN METADATA VIDEO\n")
            f.write("="*40 + "\n\n")
            f.write(state["video_package"])
            f.write("\n")
            
        logger.info("Successfully compiled Góc Tối Pháp Luật documentary script.")
    except Exception as e:
        logger.error(f"Failed to compile output file: {e}")

def save_chapters_as_files(state: Dict[str, Any]):
    """Saves each generated section/chapter to output/novel/chapters/*.md."""
    chapters_dir = "output/novel/chapters"
    os.makedirs(chapters_dir, exist_ok=True)
    logger.info(f"Saving chapter files to {chapters_dir}...")
    
    for sec_num in range(1, 7):
        sec_key = str(sec_num)
        filename = f"{sec_num:02d}.md"
        file_path = os.path.join(chapters_dir, filename)
        
        content = state["sections"][sec_key]
        
        if sec_num == 6:
            metadata_block = f"""

=========================================
=== YOUTUBE VIDEO METADATA PACKAGE ===
=========================================
{state["teaser"]}

=========================================
{state["video_package"]}
"""
            content += metadata_block
            
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
            
    logger.info("Successfully saved all 6 chapter files.")

def parse_prompt(prompt_text: str) -> tuple:
    """Parses prompt to extract True Crime Case (figure) and Title."""
    # E.g. "Viết kịch bản chi tiết về vụ án Bạch Hải Đường: Tướng cướp hào hoa bằng tiếng Việt..."
    match = re.search(r"vụ án\s+(.*?):\s*(.*?)\s+bằng", prompt_text, re.IGNORECASE)
    if match:
        figure = match.group(1).strip()
        title = match.group(2).strip()
        return figure, title
        
    if ":" in prompt_text:
        parts = prompt_text.split(":")
        figure = parts[0].strip()
        figure = re.sub(r"Viết kịch bản chi tiết về vụ án\s+", "", figure, flags=re.IGNORECASE).strip()
        title = parts[1].strip()
        title = re.sub(r"\s+bằng tiếng Việt.*", "", title, flags=re.IGNORECASE).strip()
        return figure, title
        
    topic = prompt_text.strip()
    topic = re.sub(r"Viết kịch bản chi tiết về vụ án\s+", "", topic, flags=re.IGNORECASE).strip()
    topic = re.sub(r"\s+bằng tiếng Việt.*", "", topic, flags=re.IGNORECASE).strip()
    return topic, topic

def main():
    parser = argparse.ArgumentParser(description="Generate Goc Toi Phap Luat story using Gemini.")
    parser.add_argument("--prompt", type=str, required=True, help="Input prompt from sheet orchestrator.")
    args = parser.parse_args()
    
    logger.info("Initializing Góc Tối Pháp Luật Script Generator...")
    state = load_state()
    
    figure, title = parse_prompt(args.prompt)
    logger.info(f"Parsed Case: '{figure}' | Parsed Title: '{title}'")
    
    if state.get("topic") != figure or state.get("title") != title:
        logger.info("New topic detected. Resetting state.")
        state = {
            "topic": figure,
            "title": title,
            "outline": [],
            "sections": {},
            "teaser": "",
            "video_package": "",
            "completed": False
        }
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
            
    if not state["outline"]:
        run_phase_0(state, figure, title)
        
    for sec_num in range(1, 7):
        sec_key = str(sec_num)
        if sec_key not in state["sections"]:
            try:
                if sec_num > 1:
                    time.sleep(2)
                section_text = generate_section(state, sec_num)
                state["sections"][sec_key] = section_text
                save_state(state)
            except Exception as e:
                logger.error(f"Execution halted at section {sec_num}: {e}. Run again to resume.")
                sys.exit(1)
        else:
            logger.info(f"Section {sec_num} already generated. Skipping.")

    if not state["teaser"]:
        run_phase_3(state)
        
    if not state["video_package"]:
        run_phase_4(state)
        
    save_chapters_as_files(state)
    compile_final_output(state)
    
    state["completed"] = True
    save_state(state)
    logger.info("Generation complete! Final script saved to goctoiphapluat_output.txt")

if __name__ == "__main__":
    main()
