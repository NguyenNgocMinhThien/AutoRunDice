import { chromium } from 'playwright';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';
import { google } from 'googleapis';

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];
const MIN_SALARY_ANNUAL = 60000;
const SPREADSHEET_ID = '1TvG_bxAE0AIStNuAxVMrfYdnJepKWvRGhDkFTRcRIzs';
const SHEET_GID = '1376713036';

// ====================== GOOGLE SHEETS ======================
async function getGoogleSheetsClient() {
    const credJson = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
    if (!credJson) {
        console.error("❌ Thiếu GDRIVE_SERVICE_ACCOUNT_JSON env variable");
        return null;
    }
    try {
        const credentials = JSON.parse(credJson);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        return google.sheets({ version: 'v4', auth });
    } catch (e) {
        console.error("❌ Lỗi parse credentials:", e.message);
        return null;
    }
}

async function getSheetNameByGid(sheets, gid) {
    try {
        const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheet = res.data.sheets.find(s => String(s.properties.sheetId) === String(gid));
        return sheet ? sheet.properties.title : null;
    } catch (e) {
        console.error("❌ Lỗi lấy sheet name:", e.message);
        return null;
    }
}

async function writeToGoogleSheet(jobs) {
    if (!jobs.length) return;
    const sheets = await getGoogleSheetsClient();
    if (!sheets) return;

    const sheetName = await getSheetNameByGid(sheets, SHEET_GID);
    if (!sheetName) {
        console.error(`❌ Không tìm thấy sheet với GID: ${SHEET_GID}`);
        return;
    }
    console.log(`📊 Ghi vào sheet: "${sheetName}"`);

    try {
        // Xóa data cũ từ row 3 trở đi (giữ row 1: title, row 2: header)
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A3:Z`
        });

        // Ghi data từ row 3
        const rows = jobs.map(job => [
            job.Title, job.Company, job.Salary,
            job.Location, job.Posted, job.Link, job.Keyword
        ]);
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A3`,  // ← bắt đầu từ A3
            valueInputOption: 'RAW',
            requestBody: { values: rows }
        });

        console.log(`✅ Đã ghi ${jobs.length} jobs vào Google Sheet!`);
        console.log(`🔗 https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${SHEET_GID}`);
    } catch (e) {
        console.error("❌ Lỗi ghi Google Sheet:", e.message);
    }
}

// ====================== HÀM HỖ TRỢ ======================
function parseSalaryMin(salaryStr) {
    if (!salaryStr) return 0;
    const s = salaryStr.replace(/,/g, '').toUpperCase();
    const nums = s.match(/\d+(\.\d+)?/g);
    if (!nums) return 0;
    const firstNum = parseFloat(nums[0]);
    if (s.includes('/HR') || s.includes('PER HOUR') || s.includes('/HOUR')) return firstNum * 2080;
    if (firstNum < 500) return firstNum * 2080;
    return firstNum;
}

async function uploadToCatbox(filePath) {
    let attempts = 0;
    while (attempts < 3) {
        attempts++;
        try {
            console.log(`📤 Đang upload lên Catbox (Lần ${attempts})...`);
            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('time', '72h');
            form.append('fileToUpload', fs.createReadStream(filePath));
            const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                headers: form.getHeaders(), timeout: 45000,
                maxBodyLength: Infinity, maxContentLength: Infinity
            });
            const fileLink = response.data.trim();
            if (fileLink.includes('https://')) { console.log("✅ Upload Catbox thành công!"); return fileLink; }
        } catch (error) {
            console.error(`❌ Lỗi Catbox (Lần ${attempts}):`, error.message);
            if (attempts < 3) await new Promise(r => setTimeout(r, 5000));
        }
    }
    return null;
}

async function sendTeamsAlert(message, fileLink = null) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "themeColor": "0076D7",
            "summary": "Dice.com Scraper Report",
            "sections": [{
                "activityTitle": "🎯 Dice.com Scraper",
                "activitySubtitle": `Min $${MIN_SALARY_ANNUAL.toLocaleString()}/year`,
                "facts": [{ "name": "Số job tìm thấy:", "value": message }],
                "text": fileLink ? `🔗 File: ${fileLink}` : ""
            }]
        });
        console.log("✅ Đã gửi thông báo lên Microsoft Teams");
    } catch (e) { console.error("❌ Lỗi gửi Teams:", e.message); }
}

async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) {}
}

async function sendTelegramFile(filePath) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId || !fs.existsSync(filePath)) return;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, form, { headers: form.getHeaders() });
    } catch (e) {}
}

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log(`🚀 Khởi động Dice.com Scraper (Min $${MIN_SALARY_ANNUAL.toLocaleString()}/year)...`);

    const browser = await chromium.launch({ headless: true });
    let allJobs = [];
    const seenLinks = new Set();

    for (const keyword of KEYWORDS) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            console.log(`🔍 Quét từ khóa: ${keyword} (Lần ${attempts})...`);

            try {
                const page = await browser.newPage();
                await page.setViewportSize({ width: 1920, height: 1080 });

                const url = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&countryCode=US&radius=30&radiusUnit=mi&language=en&page=1&pageSize=50`;
                await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
                await page.waitForTimeout(15000);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(5000);

                const result = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const links = document.querySelectorAll('a[href*="/job-detail/"]');

                    links.forEach(link => {
                        const title = link.textContent.trim();
                        if (!title || title.length < 10) return;
                        if (['Easy Apply', 'Apply Now', 'Apply'].includes(title)) return;

                        const fullLink = link.href.split('?')[0];

                        // Leo lên tìm card chứa span.logo
                        let card = null;
                        let el = link;
                        for (let i = 0; i < 10; i++) {
                            el = el.parentElement;
                            if (!el) break;
                            if (el.querySelector('span[class*="logo"]')) { card = el; break; }
                        }
                        if (!card) {
                            card = link.closest('article') ||
                                   link.closest('div[class*="search-result"]') ||
                                   link.closest('div[class*="card"]') ||
                                   link.closest('li') ||
                                   link.parentElement?.parentElement?.parentElement;
                        }
                        if (!card) return;

                        const textToSearch = card.textContent.replace(/\s+/g, " ").trim();

                        // SALARY
                        let salary = "";
                        const patterns = [
                            /(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/,
                            /(\d{5,6}\s*-\s*\d{5,6})/,
                            /USD[\s\$]*[\d,.]+(?:\s*-\s*[\d,.]+)?/i,
                            /(\d{2,3}k?\s*-\s*\d{2,3}k?)/i,
                            /\$[\d,]+/,
                            /\d{2,3}\s*-\s*\d{2,3}/
                        ];
                        for (const regex of patterns) {
                            const match = textToSearch.match(regex);
                            if (match && match[0].length >= 4) { salary = match[0].trim(); break; }
                        }
                        if (!salary) return;

                        // COMPANY
                        let company = "N/A";
                        const logoSpan = card.querySelector('span[class*="logo"]');
                        if (logoSpan) {
                            const p = logoSpan.querySelector('a p') || logoSpan.querySelector('p');
                            if (p) {
                                const txt = p.textContent.trim();
                                if (txt.length > 2 && txt !== title && !txt.includes('Apply')) company = txt;
                            }
                        }
                        if (company === "N/A") {
                            const mbP = card.querySelector('p.mb-0');
                            if (mbP) {
                                const txt = mbP.textContent.trim();
                                if (txt.length > 2 && txt !== title && !txt.includes('Apply') && !txt.includes('$')) company = txt;
                            }
                        }

                        // LOCATION + POSTED
                        let location = "N/A";
                        let posted = "";
                        const metaPs = Array.from(card.querySelectorAll('p.text-sm.font-normal.text-zinc-600'))
                            .filter(p => { const t = p.textContent.trim(); return t.length > 2 && t !== '•' && !t.includes('$'); });
                        if (metaPs[0]) location = metaPs[0].textContent.trim();
                        if (metaPs[1]) posted = metaPs[1].textContent.trim();

                        jobs.push({ title, company, salary, location, posted, link: fullLink });
                    });

                    return { totalLinks: links.length, jobsFound: jobs.length, jobs };
                }, keyword);

                console.log(`🔗 Tìm thấy ${result.totalLinks} link | 💰 Có salary: ${result.jobsFound}`);

                let passed = 0;
                for (const job of result.jobs) {
                    if (seenLinks.has(job.link)) continue;
                    if (parseSalaryMin(job.salary) < MIN_SALARY_ANNUAL) continue;
                    seenLinks.add(job.link);
                    passed++;
                    allJobs.push({
                        Title: job.title, Company: job.company, Salary: job.salary,
                        Location: job.location, Posted: job.posted, Link: job.link, Keyword: keyword
                    });
                }
                console.log(`✅ Qua filter: ${passed} job`);
                if (result.jobs.length > 0) console.log("📋 Sample:", result.jobs.slice(0, 3));

                await page.close();
                if (result.jobsFound > 0) break;

            } catch (error) {
                console.log(`❌ Lỗi ${keyword} (Lần ${attempts}):`, error.message);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }

    await browser.close();

    if (allJobs.length > 0) {
        // Lưu Excel
        const fileName = "Dice_Jobs_Final.xlsx";
        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);
        console.log(`\n✅ Đã lưu ${allJobs.length} jobs → ${fileName}`);

        // Ghi Google Sheet
        await writeToGoogleSheet(allJobs);

        // Upload + notify
        const fileLink = await uploadToCatbox(fileName);
        const sheetLink = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=${SHEET_GID}`;
        const alertMsg = `✅ Dice.com: ${allJobs.length} jobs min $${MIN_SALARY_ANNUAL.toLocaleString()}/year!\n📊 Sheet: ${sheetLink}\n🔗 File: ${fileLink || 'N/A'}`;
        await sendTelegramAlert(alertMsg);
        await sendTeamsAlert(`${allJobs.length} jobs`, fileLink);
        await sendTelegramFile(fileName);
    } else {
        console.log("❌ Không tìm thấy job nào phù hợp.");
        await sendTelegramAlert("❌ Dice.com: 0 job phù hợp.");
        await sendTeamsAlert("0 jobs");
    }
}

runScraper().catch(console.error);