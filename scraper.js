import { chromium } from 'playwright';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ====================== HÀM HỖ TRỢ ======================
async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '72h');           // tăng thời gian
        form.append('fileToUpload', fs.createReadStream(filePath));

        const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
            headers: form.getHeaders(),
            timeout: 30000
        });

        const link = response.data.trim();
        return link.includes('https') ? link : null;
    } catch (error) {
        console.error("❌ Catbox error:", error.message);
        return null;
    }
}

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (e) { }
}

async function sendTelegramFile(filePath) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !fs.existsSync(filePath)) return;
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`, form, { headers: form.getHeaders() });
    } catch (e) { }
}

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Dice.com Scraper v2 - Ultra Salary Mode");

    const browser = await chromium.launch({ 
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });

    let allJobs = new Map(); // Dùng Map để chống duplicate theo link

    for (const keyword of KEYWORDS) {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            console.log(`🔍 Quét "${keyword}" (Lần ${attempts})...`);

            const page = await browser.newPage();
            await page.setViewportSize({ width: 1920, height: 1080 });

            try {
                const url = `https://www.dice.com/jobs?q=${encodeURIComponent(keyword)}&countryCode=US&radius=30&radiusUnit=mi&page=1&pageSize=100`;
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // Chờ job cards load
                await page.waitForSelector('a[href*="/job-detail/"]', { timeout: 30000 });

                const jobs = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const cards = document.querySelectorAll('div[class*="search-result"], article, [data-cy*="job-card"]');

                    cards.forEach(card => {
                        const linkEl = card.querySelector('a[href*="/job-detail/"]');
                        if (!linkEl) return;

                        const title = linkEl.textContent.trim();
                        if (title.length < 8 || title === "Easy Apply") return;

                        const fullLink = linkEl.href.split('?')[0]; // loại query param

                        // === Extract Salary (ưu tiên text trong card) ===
                        let salary = "";
                        const salaryPatterns = [
                            /\$[\d,]+(?:\s*-\s*\$?[\d,]+)?/,
                            /\b\d{2,3}k?\s*-\s*\d{2,3}k?\b/i,
                            /\b\d{5,6}\s*-\s*\d{5,6}\b/,
                            /USD\s*[\d,]+/i,
                            /\b\d{1,3}(?:,\d{3})+(?:\s*-\s*\d{1,3}(?:,\d{3})+)?\b/
                        ];

                        const cardText = card.textContent.replace(/\s+/g, " ");

                        for (const regex of salaryPatterns) {
                            const match = cardText.match(regex);
                            if (match) {
                                salary = match[0].trim();
                                // Lọc noise
                                if (/^\d{1,3}-\d{1,3}$/.test(salary) && salary.length < 8) continue;
                                break;
                            }
                        }

                        if (!salary) return; // chỉ lấy job có salary

                        // === Company ===
                        let company = "N/A";
                        const companySelectors = [
                            '[data-cy*="company"]',
                            'a[href*="/company/"]',
                            '.company-name',
                            'span[class*="Company"]'
                        ];

                        for (const sel of companySelectors) {
                            const el = card.querySelector(sel);
                            if (el) {
                                company = el.textContent.trim();
                                break;
                            }
                        }

                        // === Location ===
                        let location = "N/A";
                        const locEl = card.querySelector('span[class*="location"], .location');
                        if (locEl) location = locEl.textContent.trim();

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary,
                            Location: location,
                            Link: fullLink,
                            Keyword: currentKeyword,
                            ScrapedAt: new Date().toISOString()
                        });
                    });

                    return jobs;
                }, keyword);

                console.log(`   → Tìm thấy ${jobs.length} job có lương`);

                // Thêm vào Map để chống duplicate
                jobs.forEach(job => {
                    allJobs.set(job.Link, job);
                });

                await page.close();
                if (jobs.length > 0) break;

            } catch (error) {
                console.log(`❌ Lỗi ${keyword} (Lần ${attempts}):`, error.message);
                await page.close();
                await new Promise(r => setTimeout(r, 8000));
            }
        }
    }

    await browser.close();

    const finalJobs = Array.from(allJobs.values());

    if (finalJobs.length === 0) {
        await sendTelegramAlert("❌ Dice.com: Không tìm thấy job nào có lương.");
        console.log("❌ Không có job nào.");
        return;
    }

    // ====================== LƯU FILE ======================
    const fileName = `Dice_Jobs_${new Date().toISOString().slice(0,10)}.xlsx`;
    const worksheet = XLSX.utils.json_to_sheet(finalJobs);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
    XLSX.writeFile(workbook, fileName);

    console.log(`✅ Đã lưu ${finalJobs.length} jobs độc nhất vào ${fileName}`);

    const catboxLink = await uploadToCatbox(fileName);
    const alertMsg = `✅ <b>Dice.com Scraper</b>\n` +
                    `📊 Tìm thấy: <b>${finalJobs.length}</b> jobs có lương\n` +
                    `${catboxLink ? `🔗 ${catboxLink}` : ''}`;

    await sendTelegramAlert(alertMsg);
    await sendTelegramFile(fileName);
}

runScraper().catch(console.error);