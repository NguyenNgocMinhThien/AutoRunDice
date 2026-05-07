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
    console.log("🚀 Khởi động Dice.com Scraper (Ultra Salary Mode)...");

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

                const result = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const links = document.querySelectorAll('a[href*="/job-detail/"]');

                    links.forEach(link => {
                        const title = link.textContent.trim();
                        if (!title || title.length < 10) return;

                        const fullLink = link.href;

                        // Tìm vùng chứa salary rộng nhất
                        let textToSearch = document.body.textContent || "";

                        // Hoặc thu hẹp quanh link
                        let parent = link.parentElement;
                        for (let i = 0; i < 8; i++) {
                            if (parent) {
                                textToSearch = parent.textContent || textToSearch;
                                parent = parent.parentElement;
                            }
                        }

                        textToSearch = textToSearch.replace(/\s+/g, " ");

                        // Salary patterns siêu rộng
                        let salary = "";
                        const patterns = [
                            /(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/,
                            /(\d{2,3}k?\s*-\s*\d{2,3}k?)/i,
                            /(\d{5,6}\s*-\s*\d{5,6})/,
                            /USD\s*[\d,]+/i,
                            /\$[\d,]+/ 
                        ];

                        for (const regex of patterns) {
                            const match = textToSearch.match(regex);
                            if (match && match[0].length > 4) {
                                salary = match[0];
                                break;
                            }
                        }

                        if (!salary) return;

                        // Company
                        let company = "N/A";
                        const companyEl = link.closest('div').querySelector('a[data-cy*="company"], [class*="company"]');
                        if (companyEl) company = companyEl.textContent.trim();

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

                    return { totalLinks: links.length, jobsWithSalary: jobs.length, sample: jobs.slice(0, 3) };
                }, keyword);

                console.log(`🔗 Tìm thấy ${result.totalLinks} link job`);
                console.log(`💰 Tìm thấy ${result.jobsWithSalary} job có salary`);

                if (result.sample && result.sample.length > 0) {
                    console.log("📋 Sample jobs:", result.sample);
                }

                allJobs = allJobs.concat(result.sample || []);

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
        console.log("❌ Không tìm thấy job nào có salary.");
    }
}

runScraper().catch(console.error);