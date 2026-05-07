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

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper (Debug Salary)...");

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
                await page.waitForTimeout(12000);

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(4000);

                const result = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    let salaryFoundCount = 0;

                    const links = document.querySelectorAll('a[href*="/job-detail/"]');

                    links.forEach(link => {
                        const title = link.textContent.trim();
                        if (!title || title.length < 10) return;

                        const fullLink = link.href;

                        let card = link.closest('div') || link.parentElement;
                        const fullText = card ? card.textContent : "";

                        // Tìm salary - nhiều pattern
                        let salary = "";
                        const patterns = [
                            /(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/,
                            /(\d{2,3}k?\s*-\s*\d{2,3}k?)/i,
                            /(\d{5,6}\s*-\s*\d{5,6})/
                        ];

                        for (const regex of patterns) {
                            const match = fullText.match(regex);
                            if (match) {
                                salary = match[0];
                                salaryFoundCount++;
                                break;
                            }
                        }

                        if (!salary) return;

                        // Company
                        let company = "N/A";
                        const companyEl = card.querySelector('a[data-cy*="company"], .company, [class*="company"]');
                        if (companyEl) company = companyEl.textContent.trim();

                        if (company === "N/A") {
                            const after = fullText.substring(fullText.indexOf(title) + title.length).trim().substring(0, 100);
                            const match = after.match(/^[\s•-]*([A-Za-z0-9\s&.,'-]{5,60})/);
                            if (match) company = match[1].trim();
                        }

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary,
                            Location: "N/A",
                            Posted: "",
                            Link: fullLink,
                            Keyword: currentKeyword
                        });
                    });

                    return { 
                        totalLinks: links.length, 
                        jobsWithSalary: jobs.length, 
                        jobs: jobs.slice(0, 3) 
                    };
                }, keyword);

                console.log(`🔗 Tìm thấy ${result.totalLinks} link job`);
                console.log(`💰 Tìm thấy ${result.jobsWithSalary} job có salary`);
                if (result.jobs.length > 0) {
                    console.log("📋 Sample:", result.jobs);
                }

                allJobs = allJobs.concat(result.jobs);

                await page.close();
                if (result.jobsWithSalary > 0) break;

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

        console.log(`✅ Đã lưu ${allJobs.length} jobs`);

        const fileLink = await uploadToCatbox(fileName);
        await sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs có lương!`);
        await sendTelegramFile(fileName);
    } else {
        await sendTelegramAlert("❌ Vẫn không tìm thấy job có salary.");
        console.log("❌ Không tìm thấy job nào.");
    }
}

runScraper().catch(console.error);