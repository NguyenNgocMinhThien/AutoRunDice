import { chromium } from 'playwright';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// ====================== HÀM HỖ TRỢ ======================
async function uploadToCatbox(filePath) {
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('time', '24h');
        form.append('fileToUpload', fs.createReadStream(filePath));

        const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
            headers: form.getHeaders()
        });

        const fileLink = response.data.trim();
        if (fileLink.includes('https://')) return fileLink;
        throw new Error("Invalid link: " + fileLink);
    } catch (error) {
        console.error("❌ Lỗi Catbox:", error.message);
        return `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`;
    }
}

async function sendToTeams(totalJobs, fileLink) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    const adaptiveCard = {
        "type": "AdaptiveCard", "version": "1.4",
        "body": [
            { "type": "TextBlock", "text": "🚀 CẬP NHẬT JOB MỚI TẠI DICE.COM", "weight": "Bolder", "size": "Medium", "color": "Accent" },
            { "type": "FactSet", "facts": [
                { "title": "Nguồn:", "value": "Dice.com" },
                { "title": "Số lượng:", "value": `${totalJobs} jobs` },
                { "title": "Trạng thái:", "value": "Đã sẵn sàng ✅" }
            ]}
        ],
        "actions": [{ "type": "Action.OpenUrl", "title": "📥 TẢI FILE EXCEL", "url": fileLink }],
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
    };

    try {
        await axios.post(webhookUrl, adaptiveCard);
        console.log("✅ [Teams] Đã gửi Card thành công!");
    } catch (error) {
        console.error("❌ [Teams] Lỗi:", error.message);
    }
}

async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML'
        });
    } catch (e) { console.error("❌ Telegram Alert Error:", e.message); }
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
    } catch (e) { console.error("❌ Telegram File Error:", e.message); }
}

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper bằng Playwright...");

    const browser = await chromium.launch({ headless: true });
    let allJobs = [];

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
                await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

                // Chờ job cards load
                await page.waitForSelector('a[href*="/job-detail/"]', { timeout: 30000 }).catch(() => {});

                const jobsOnPage = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const cards = document.querySelectorAll('div[class*="card"], article, div[data-cy="search-card"]');

                    cards.forEach(card => {
                        const titleLink = card.querySelector('a[href*="/job-detail/"]');
                        if (!titleLink) return;

                        const title = titleLink.textContent.trim();
                        if (!title) return;

                        const link = titleLink.href;

                        // Company
                        let company = "N/A";
                        const companyEl = card.querySelector('a[data-cy="company-name"], .company-name, .employer');
                        if (companyEl) company = companyEl.textContent.trim();

                        // Location
                        let location = "N/A";
                        const locEl = card.querySelector('[data-cy="location"], .location, .job-location');
                        if (locEl) location = locEl.textContent.trim();

                        // Salary
                        let salary = "";
                        const salaryEl = card.querySelector('[data-cy="salary"], .salary, .compensation');
                        if (salaryEl) salary = salaryEl.textContent.trim();

                        // Posted time
                        let posted = "";
                        const postedEl = card.querySelector('time, .time, [data-testid="posted-time"]');
                        if (postedEl) posted = postedEl.textContent.trim();

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary,
                            Location: location,
                            Posted: posted,
                            Link: link,
                            Keyword: currentKeyword
                        });
                    });

                    return jobs;
                }, keyword);

                console.log(`✅ Lấy được ${jobsOnPage.length} jobs cho "${keyword}"`);
                allJobs = allJobs.concat(jobsOnPage);

                await page.close();
                if (jobsOnPage.length > 5) break;

            } catch (error) {
                console.log(`❌ Lỗi ${keyword} (Lần ${attempts}):`, error.message);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }

    await browser.close();

    if (allJobs.length > 0) {
        const fileName = "Dice_Jobs_Final.xlsx";
        const worksheet = XLSX.utils.json_to_sheet(allJobs);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
        XLSX.writeFile(workbook, fileName);

        console.log(`📊 Đã lưu ${allJobs.length} jobs vào ${fileName}`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs mới!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);

        console.log("🏁 Hoàn tất!");
    } else {
        await sendTelegramAlert("❌ Không tìm thấy job mới nào trên Dice.com.");
    }
}

runScraper().catch(console.error);