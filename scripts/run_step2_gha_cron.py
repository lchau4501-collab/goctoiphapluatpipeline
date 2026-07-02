import os
import sys
import subprocess
import logging
from google_api_helper import get_gspread_client, create_drive_folder

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Step2Cron")

GDRIVE_PARENT_FOLDER_ID = "1BABIF2g-U6RqAgNyjs7hOACOiPmFvYPC" # Default placeholder, GHA will use secrets if set

def main():
    spreadsheet_id = os.environ.get("SPREADSHEET_ID", "1FXYJOhyMxNpUNYpLf5O6Tf6UehI1ulHa_B8HzwTkmdM")
    parent_folder_id = os.environ.get("GDRIVE_PARENT_FOLDER_ID", GDRIVE_PARENT_FOLDER_ID)
    logger.info(f"Connecting to Google Sheet: {spreadsheet_id}")
    
    try:
        gc = get_gspread_client()
        sh = gc.open_by_key(spreadsheet_id)
        ws = sh.worksheet("goctoiphapluat")
    except Exception as e:
        logger.error(f"Failed to access Google Sheet: {e}")
        sys.exit(1)
        
    rows = ws.get_all_values()
    headers = [h.strip() for h in rows[0]]
    
    if "ID" not in headers or "Status" not in headers:
        logger.error("Required columns ID or Status not found in goctoiphapluat tab.")
        sys.exit(1)
        
    id_col = headers.index("ID")
    status_col = headers.index("Status")
    figure_col = headers.index("Historical Figure") if "Historical Figure" in headers else -1
    title_col = headers.index("Video Title") if "Video Title" in headers else -1
    folder_col = headers.index("GDrive Folder Link") if "GDrive Folder Link" in headers else -1
    
    # Find all rows with status 'pending'
    pending_rows = []
    for idx, r in enumerate(rows[1:], start=2):
        if len(r) > status_col and r[status_col].strip().lower() == "pending":
            pending_rows.append((idx, r))
            
    if not pending_rows:
        logger.info("No rows with status 'pending' found. Exiting.")
        sys.exit(0)
        
    logger.info(f"Found {len(pending_rows)} rows with status 'pending'. Starting execution...")
    
    for idx, r in pending_rows:
        episode_id = r[id_col]
        figure = r[figure_col] if figure_col != -1 and len(r) > figure_col else ""
        title = r[title_col] if title_col != -1 and len(r) > title_col else ""
        folder_link = r[folder_col] if folder_col != -1 and len(r) > folder_col else ""
        
        logger.info(f"--- Processing row {idx}: {figure} - {title} (ID: {episode_id}) ---")
        
        # 1. Create GDrive folder if not present
        if not folder_link and folder_col != -1:
            try:
                folder_name = title if title else (figure if figure else f"Episode {episode_id[:8]}")
                _, folder_url = create_drive_folder(folder_name, parent_folder_id)
                ws.update_cell(idx, folder_col + 1, folder_url)
                logger.info(f"Created GDrive folder: {folder_url}")
            except Exception as e:
                logger.error(f"Failed to create GDrive folder for row {idx}: {e}")
                continue
                
        # 2. Build prompt and run ainovel-cli
        prompt = f"Viết kịch bản chi tiết về vụ án {figure}: {title} bằng tiếng Việt, theo phong cách Góc Tối Pháp Luật."
        logger.info(f"Running ainovel-cli with prompt: {prompt}")
        
        try:
            # Clean up old gdoc1/2 files if exist
            for f in ["gdoc1.txt", "gdoc2.txt"]:
                if os.path.exists(f):
                    os.remove(f)
                    
            # Run Python script generator
            subprocess.run([sys.executable, "scripts/generate_goc_toi_phap_luat.py", "--prompt", prompt], check=True)
            
            # Post-process
            logger.info("Running post_process.py...")
            subprocess.run([sys.executable, "scripts/post_process.py"], check=True)
            
            # Upload to GDrive
            logger.info("Running upload_gdrive.py...")
            env = os.environ.copy()
            env["EPISODE_ID"] = episode_id
            env["ROW_ID"] = episode_id
            subprocess.run([sys.executable, "scripts/upload_gdrive.py"], env=env, check=True)
            
            logger.info(f"Row {idx} scripting completed successfully!")
            
        except Exception as e:
            logger.error(f"Failed to process scripting for row {idx}: {e}")
            try:
                ws.update_cell(idx, status_col + 1, "step2failed")
                logger.info(f"Updated row {idx} status to 'step2failed'")
            except Exception as se:
                logger.error(f"Failed to update status to step2failed for row {idx}: {se}")
            continue
            
    logger.info("Step 2 Cron run completed.")

if __name__ == "__main__":
    main()
