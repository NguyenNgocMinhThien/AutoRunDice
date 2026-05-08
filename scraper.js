import { chromium } from 'playwright';
import XLSX from 'xlsx';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

const KEYWORDS = ["Analyst", "CFA", "CEO", "Data Science", "FP&A"];

// ====================== HÀM HỖ TRỢ ======================
async function uploadToCatbox(filePath) {
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            console.log(`📤 Đang upload lên Catbox (Lần ${attempts})...`);

            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('time', '72h');
            form.append('fileToUpload', fs.createReadStream(filePath));

            const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                headers: form.getHeaders(),
                timeout: 45000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });

            const fileLink = response.data.trim();
            if (fileLink.includes('https://')) {
                console.log("✅ Upload Catbox thành công!");
                return fileLink;
            }
        } catch (error) {
            console.error(`❌ Lỗi Catbox (Lần ${attempts}):`, error.message);
            if (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    console.error("❌ Catbox upload thất bại sau 3 lần thử");
    return null;
}

// ==================== MICROSOFT TEAMS ====================
async function sendTeamsAlert(message, fileLink = null) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        const payload = {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "themeColor": "0076D7",
            "summary": "Dice.com Scraper Report",
            "sections": [{
                "activityTitle": "🎯 Dice.com Scraper",
                "activitySubtitle": "Ultra Salary Mode",
                "facts": [
                    { "name": "Số job tìm thấy:", "value": message },
                ],
                "text": fileLink ? `🔗 File: ${fileLink}` : ""
            }]
        };

        await axios.post(webhookUrl, payload);
        console.log("✅ Đã gửi thông báo lên Microsoft Teams");
    } catch (e) {
        console.error("❌ Lỗi gửi Teams:", e.message);
    }
}

// ====================== TELEGRAM ======================
async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (e) { }
}

async function sendTelegramFile(filePath) {
    const botToken = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId || !fs.existsSync(filePath)) return;

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath));
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendDocument`, form, {
            headers: form.getHeaders()
        });
    } catch (e) { }
}

// ====================== HÀM CHÍNH ======================
async function runScraper() {
    console.log("🚀 Khởi động Dice.com Scraper (Ultra Salary Mode)...");

    const browser = await chromium.launch({ headless: true });
    let allJobs = [];

    // ... (phần scrape giữ nguyên hoàn toàn như code cũ của bạn)

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
                    // DEBUG - XÓA SAU KHI FIX XONG
                    // Thay debugHTML cũ bằng cái này - dump card của job CÓ salary
                    const debugHTML = (() => {
                        const allLinks = document.querySelectorAll('a[href*="/job-detail/"]');

                        for (const link of allLinks) {
                            let card = link.closest('article') ||
                                link.closest('div[class*="search-result"]') ||
                                link.closest('div[class*="card"]') ||
                                link.closest('li') ||
                                link.parentElement?.parentElement?.parentElement;
                            if (!card) continue;

                            const text = card.textContent.replace(/\s+/g, ' ');

                            // Chỉ dump card nào có salary thực sự
                            const hasSalary = /\$[\d,]+|\d{5,6}\s*-\s*\d{5,6}|USD\s*\d+/i.test(text);
                            if (!hasSalary) continue;

                            const elements = [];
                            card.querySelectorAll('*').forEach(el => {
                                const txt = el.textContent.trim().replace(/\s+/g, ' ').substring(0, 60);
                                if (txt.length > 1) {
                                    elements.push(`<${el.tagName.toLowerCase()} class="${el.className}"> → "${txt}"`);
                                }
                            });
                            return `=== CARD CÓ SALARY: ${link.textContent.trim()} ===\n` + elements.join('\n');
                        }
                        return "Không tìm thấy card có salary";
                    })();
                    const jobs = [];
                    const links = document.querySelectorAll('a[href*="/job-detail/"]');

                    links.forEach(link => {
                        const title = link.textContent.trim();
                        if (!title || title.length < 10) return;

                        const fullLink = link.href.split('?')[0];

                        // Card rộng nhất
                        let card = link.closest('article') ||
                            link.closest('div[class*="search-result"]') ||
                            link.closest('div[class*="flex flex-col gap-6"]') ||
                            link.closest('div[class*="bg-surface-primary"]') ||
                            link.parentElement?.parentElement?.parentElement?.parentElement?.parentElement ||
                            link.closest('div');

                        let textToSearch = card ? card.textContent : document.body.textContent;
                        textToSearch = textToSearch.replace(/\s+/g, " ").trim();

                        // ================== SALARY ==================
                        let salary = "";
                        const patterns = [
                            /(\$\d{1,3}(?:,\d{3})*(?:\s*-\s*\$\d{1,3}(?:,\d{3})*)?)/,
                            /(\d{5,6}\s*-\s*\d{5,6})/,
                            /USD\s*\d+/i,
                            /(\d{2,3}k?\s*-\s*\d{2,3}k?)/i,
                            /\$[\d,]+/,
                            /\d{2,3}\s*-\s*\d{2,3}/
                        ];

                        for (const regex of patterns) {
                            const match = textToSearch.match(regex);
                            if (match && match[0].length >= 4) {
                                salary = match[0].trim();
                                break;
                            }
                        }

                        if (!salary) return;

                        // ================== COMPANY ==================
                        let company = "N/A";

                        // Leo lên từng cấp để tìm div bao ngoài cùng chứa span.logo
                        let searchEl = link;
                        for (let i = 0; i < 10; i++) {
                            searchEl = searchEl.parentElement;
                            if (!searchEl) break;

                            const logoSpan = searchEl.querySelector('span[class*="logo"]');
                            if (logoSpan) {
                                const p = logoSpan.querySelector('p');
                                if (p) {
                                    const txt = p.textContent.trim();
                                    if (txt.length > 2 && txt !== title && !txt.includes('Apply')) {
                                        company = txt;
                                    }
                                }
                                break; // Tìm thấy span.logo rồi thì dừng dù có company hay không
                            }
                        }
                        // Cách 2: p.mb-0 (fallback - thường chứa company name)
                        if (company === "N/A") {
                            const mbP = card.querySelector('p.mb-0');
                            if (mbP) {
                                const txt = mbP.textContent.trim();
                                if (txt.length > 2 && txt !== title && !txt.includes('$') && !txt.includes('Apply')) {
                                    company = txt;
                                }
                            }
                        }

                        // Cách 3: link dẫn đến /company/ hoặc employer
                        if (company === "N/A") {
                            const companyLink = card.querySelector('a[href*="/company/"], a[href*="employer"]');
                            if (companyLink) {
                                const txt = companyLink.textContent.trim();
                                if (txt.length > 2 && txt !== title) company = txt;
                            }
                        }

                        // Cách 4: text-interaction class (link company style của Dice)
                        if (company === "N/A") {
                            const allAs = card.querySelectorAll('a.text-interaction, a[class*="text-interaction"]');
                            for (const a of allAs) {
                                const txt = a.textContent.trim();
                                // Bỏ qua link job title và "Apply Now"
                                if (txt.length > 2 && txt !== title && !txt.includes('Apply') && !txt.includes('$')) {
                                    company = txt;
                                    break;
                                }
                            }
                        }
                        // ================== LOCATION + POSTED ==================
                        let location = "N/A";
                        let posted = "";

                        const metaPs = card.querySelectorAll('p.text-sm.font-normal.text-zinc-600');
                        // Lọc bỏ các p chỉ có dấu • hoặc quá ngắn
                        const validMetaPs = Array.from(metaPs).filter(p => {
                            const txt = p.textContent.trim();
                            return txt.length > 2 && txt !== '•' && !txt.includes('$');
                        });

                        // validMetaPs[0] = location, validMetaPs[1] = posted date
                        if (validMetaPs[0]) location = validMetaPs[0].textContent.trim();
                        if (validMetaPs[1]) posted = validMetaPs[1].textContent.trim();

                        jobs.push({
                            Title: title,
                            Company: company,
                            Salary: salary,
                            Location: location,
                            Posted: posted,
                            Link: fullLink,
                            Keyword: currentKeyword
                        });
                    });

                    return {
                        totalLinks: links.length,
                        jobsWithSalary: jobs.length,
                        sample: jobs.slice(0, 6),
                        debugHTML
                    };
                }, keyword);

                if (result.debugHTML) console.log("=== DEBUG ===\n", result.debugHTML); {
                    console.log(`🔗 Tìm thấy ${result.totalLinks} link job`);
                    console.log(`💰 Tìm thấy ${result.jobsWithSalary} job có salary`);
                }

                if (result.debugText) {
                    console.log("\n🔍 === DEBUG TEXT (3 jobs đầu) ===");
                    console.log(result.debugText);
                }

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

        const alertMsg = `✅ Dice.com: Tìm thấy ${allJobs.length} jobs có lương!`;

        await sendTelegramAlert(alertMsg);
        await sendTeamsAlert(allJobs.length + " jobs", fileLink);   // ← Thêm dòng này
        await sendTelegramFile(fileName);
    } else {
        await sendTelegramAlert("❌ Vẫn không tìm thấy job có salary.");
        await sendTeamsAlert("0 jobs");   // ← Thêm dòng này
        console.log("❌ Không tìm thấy job nào có salary.");
    }
}

runScraper().catch(console.error);