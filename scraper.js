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
    console.log("🚀 Khởi động Dice.com Scraper...");

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
                await page.waitForTimeout(10000);

                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(4000);

                const jobsOnPage = await page.evaluate((currentKeyword) => {
                    const jobs = [];
                    const links = document.querySelectorAll('a[href*="/job-detail/"]');

                    links.forEach(link => {
                        const title = link.textContent.trim();
                        if (!title || title.length < 10) return;

                        const fullLink = link.href;

                        // Tìm card chứa job (cha lớn hơn)
                        let card = link.closest('div[class*="card"]') || 
                                  link.closest('article') || 
                                  link.closest('div');

                        const fullText = card ? card.textContent : link.parentElement.textContent || "";

                        // Tìm salary
                        let salary = "";
                        const salaryMatch = fullText.match(/(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/);
                        if (salaryMatch) salary = salaryMatch[0];

                        if (!salary) return; // Chỉ lấy job có salary

                        // Company
                        let company = "N/A";
                        const companyEl = card.querySelector('a[data-cy="company-name"], .company-name, [class*="company"]');
                        if (companyEl) {
                            company = companyEl.textContent.trim();
                        } else {
                            // Fallback
                            const afterTitle = fullText.substring(fullText.indexOf(title) + title.length).trim().substring(0, 100);
                            const compMatch = afterTitle.match(/^[\s•-]*([A-Za-z0-9\s&.,'-]{5,70})/);
                            if (compMatch) company = compMatch[1].trim();
                        }

                        // Location
                        let location = "N/A";
                        const locMatch = fullText.match(/(Remote|Highland|Houston|Atlanta|Tampa|Detroit|New York|Chicago|Texas|Florida|New Jersey|Michigan|Utah)[^,\n]*/i);
                        if (locMatch) location = locMatch[0].trim();

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary,
                            Location: location,
                            Posted: "",
                            Link: fullLink,
                            Keyword: currentKeyword
                        });
                    });

                    return jobs;
                }, keyword);

                console.log(`✅ Lấy được ${jobsOnPage.length} jobs có lương cho "${keyword}"`);
                allJobs = allJobs.concat(jobsOnPage);

                await page.close();
                if (jobsOnPage.length > 3) break;

            } catch (error) {
                console.log(`❌ Lỗi ${keyword} (Lần ${attempts}):`, error.message);
                await new Promise(r => setTimeout(r, 12000));
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
            sendTelegramAlert(`✅ Dice.com: Tìm thấy ${allJobs.length} jobs có lương!`),
            sendTelegramFile(fileName)
        ]);
    } else {
        await sendTelegramAlert("❌ Không tìm thấy job có salary nào.");
        console.log("❌ Không tìm thấy job nào có salary.");
    }
}

runScraper().catch(console.error);