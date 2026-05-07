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
        throw new Error("Invalid link");
    } catch (error) {
        console.error("❌ Lỗi Catbox:", error.message);
        return "https://github.com";
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
    try { await axios.post(webhookUrl, adaptiveCard); } catch (e) {}
}

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper (Clean Version)...");

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
                await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
                await page.waitForTimeout(15000);

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(5000);

                const jobsOnPage = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const cards = document.querySelectorAll('div[data-cy="search-card"], article, div[class*="JobCard"]');

                    cards.forEach(card => {
                        const titleEl = card.querySelector('a[href*="/job-detail/"]');
                        if (!titleEl) return;

                        const title = titleEl.textContent.trim();
                        if (!title || title.length < 10) return;

                        const fullLink = titleEl.href;

                        const fullText = card.textContent.replace(/\s+/g, " ");

                        // Salary
                        let salary = "";
                        const salaryMatch = fullText.match(/(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/);
                        if (salaryMatch) salary = salaryMatch[0];

                        // Company
                        let company = "N/A";
                        const companyEl = card.querySelector('a[data-cy*="company"], [class*="company"], .employer');
                        if (companyEl) company = companyEl.textContent.trim();

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary || "",
                            Location: "N/A",
                            Posted: "",
                            Link: fullLink,
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

        console.log(`📊 Đã lưu ${allJobs.length} jobs`);

        const fileLink = await uploadToCatbox(fileName);

        await Promise.all([
            sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs!`),
            sendTelegramFile(fileName),
            sendToTeams(allJobs.length, fileLink)
        ]);
    } else {
        await sendTelegramAlert("❌ Không tìm thấy job nào.");
    }
}

runScraper().catch(console.error);