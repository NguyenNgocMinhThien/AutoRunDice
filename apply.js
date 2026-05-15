import { chromium } from 'playwright';
import { google } from 'googleapis';
import fs from 'fs';
import https from 'https';
import path from 'path';

// ====================== CONFIG ======================
const DICE_EMAIL = process.env.DICE_EMAIL;
const DICE_PASSWORD = process.env.DICE_PASSWORD;
const RESUME_URL = process.env.RESUME_URL;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_GID = process.env.SHEET_GID;
const JOBS_JSON = process.env.JOBS_JSON;

const RESUME_PATH = '/tmp/resume.pdf';
const LOG_PATH = 'apply_log.json';

// ====================== GOOGLE SHEETS ======================
async function getSheetsClient() {
    const cred = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;
    if (!cred) return null;
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(cred),
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        return google.sheets({ version: 'v4', auth });
    } catch (e) {
        console.error('❌ Sheets auth error:', e.message);
        return null;
    }
}

async function getSheetName(sheets, gid) {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = res.data.sheets.find(s => String(s.properties.sheetId) === String(gid));
    return sheet ? sheet.properties.title : null;
}

async function updateJobStatus(sheets, sheetName, rowNum, status, bgColor) {
    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!I${rowNum}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[status]] }
        });

        // Đổi màu background
        const sheetId = parseInt(SHEET_GID);
        const colorMap = {
            '#C8E6C9': { red: 0.78, green: 0.9, blue: 0.78 },   // xanh lá = thành công
            '#FFCDD2': { red: 1, green: 0.8, blue: 0.82 },        // đỏ = lỗi
            '#FFF9C4': { red: 1, green: 0.976, blue: 0.769 },     // vàng = đang xử lý
            '#FFE0B2': { red: 1, green: 0.878, blue: 0.698 }      // cam = cần xem lại
        };
        const color = colorMap[bgColor] || colorMap['#FFE0B2'];

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: rowNum - 1,
                            endRowIndex: rowNum,
                            startColumnIndex: 8, // cột I
                            endColumnIndex: 9
                        },
                        cell: { userEnteredFormat: { backgroundColor: color } },
                        fields: 'userEnteredFormat.backgroundColor'
                    }
                }]
            }
        });
    } catch (e) {
        console.error(`❌ Lỗi update status row ${rowNum}:`, e.message);
    }
}

// ====================== DOWNLOAD RESUME ======================
async function downloadResume(url) {
    return new Promise((resolve, reject) => {
        console.log('📥 Đang download resume...');

        // Convert Google Drive link sang direct download
        let downloadUrl = url;
        const driveMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (driveMatch) {
            downloadUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
        }

        const file = fs.createWriteStream(RESUME_PATH);
        https.get(downloadUrl, (response) => {
            // Handle redirect
            if (response.statusCode === 302 || response.statusCode === 301) {
                https.get(response.headers.location, (res2) => {
                    res2.pipe(file);
                    file.on('finish', () => { file.close(); resolve(RESUME_PATH); });
                }).on('error', reject);
            } else {
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(RESUME_PATH); });
            }
        }).on('error', (err) => {
            fs.unlink(RESUME_PATH, () => { });
            reject(err);
        });
    });
}

// ====================== LOGIN DICE ======================
async function loginDice(page) {
    console.log('🔐 Đang login Dice.com...');
    await page.goto('https://www.dice.com/dashboard/login', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Điền email
    await page.fill('input[name="email"], input[type="email"], #email', DICE_EMAIL);
    await page.waitForTimeout(1000);

    // Click Next nếu có
    const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue")');
    if (await nextBtn.count() > 0) {
        await nextBtn.first().click();
        await page.waitForTimeout(2000);
    }

    // Điền password
    await page.fill('input[name="password"], input[type="password"], #password', DICE_PASSWORD);
    await page.waitForTimeout(1000);

    // Click Sign In
    await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    await page.waitForTimeout(5000);

    // Kiểm tra login thành công
    const url = page.url();
    if (url.includes('dashboard') || url.includes('home') || !url.includes('login')) {
        console.log('✅ Login thành công!');
        return true;
    }

    console.log('❌ Login thất bại, URL:', url);
    return false;
}

// ====================== APPLY JOB ======================
async function applyJob(page, job) {
    console.log(`\n🎯 Đang apply: ${job.title} @ ${job.company}`);
    console.log(`   Link: ${job.link}`);

    try {
        // Vào trang job detail
        await page.goto(job.link, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Kiểm tra đã apply chưa
        if (await page.locator('button:has-text("Applied")').count() > 0) {
            console.log('   ℹ️ Job này đã apply rồi');
            return { success: true, status: 'ℹ️ Đã apply trước đó' };
        }

        // ===== BƯỚC 1: Click Easy Apply → vào wizard =====
        const applyLink = page.locator('a[href*="/job-applications/"]').first();
        if (await applyLink.count() === 0) {
            console.log('   ⚠️ Không tìm thấy nút Easy Apply');
            return { success: false, status: '⚠️ Không tìm thấy nút Easy Apply' };
        }
        await applyLink.click();
        await page.waitForURL('**/wizard**', { timeout: 15000 });
        await page.waitForTimeout(2000);
        console.log('   ✅ Bước 1: Vào wizard thành công');

        // ===== BƯỚC 2: Resume → Next =====
        console.log('   📎 Bước 2: Xử lý resume...');
        const existingResume = page.locator('p:has-text(".pdf"), a:has-text(".pdf")');
        if (await existingResume.count() > 0) {
            console.log('   ✅ Resume đã có sẵn');
        } else {
            const fileInput = page.locator('input[type="file"]').first();
            if (await fileInput.count() > 0) {
                await fileInput.setInputFiles(RESUME_PATH);
                await page.waitForTimeout(3000);
                console.log('   ✅ Upload resume xong');
            }
        }
        let url1 = page.url();
        await page.locator('button:has-text("Next")').first().click();
        // Chờ URL thay đổi hoặc tối đa 5s
        for (let i = 0; i < 10; i++) {
            await page.waitForTimeout(500);
            if (page.url() !== url1) break;
        }
        console.log('   ✅ Bước 2 xong, URL:', page.url());

        // ===== BƯỚC 3: Cover Letter → Next =====
        console.log('   📝 Bước 3: Cover letter...');
        const hasCoverLetter = await page.locator('text=Cover letter, text=cover letter').count() > 0;
        if (hasCoverLetter) {
            let url2 = page.url();
            await page.locator('button:has-text("Next")').first().click();
            for (let i = 0; i < 10; i++) {
                await page.waitForTimeout(500);
                if (page.url() !== url2) break;
            }
            console.log('   ✅ Bước 3 xong, URL:', page.url());
        }

        // ===== Log buttons để debug =====
        const btns = await page.evaluate(() =>
            Array.from(document.querySelectorAll('button'))
                .map(b => b.textContent.trim()).filter(t => t.length > 0)
        );
        console.log('   🔘 Buttons trước Submit:', btns);

        // ===== BƯỚC 4: Submit =====
        console.log('   📝 Bước 4: Submit...');
        try {
            await page.waitForSelector('button:has-text("Submit")', { timeout: 10000 });
        } catch (e) {
            return { success: false, status: '⚠️ Không tìm thấy nút Submit' };
        }
        await page.locator('button:has-text("Submit")').first().click();
        await page.waitForTimeout(3000);

        const isSuccess =
            page.url().includes('/success') ||
            await page.locator('text=Your application is on its way').count() > 0 ||
            await page.locator('text=Excellent').count() > 0;

        if (isSuccess) {
            console.log('   🎉 Apply thành công!');
            return { success: true, status: '✅ Đã apply thành công' };
        }
        return { success: false, status: '⚠️ Cần kiểm tra thủ công' };

        // ===== Kiểm tra thành công =====
        const isSuccess =
            page.url().includes('/success') ||
            await page.locator('text=Your application is on its way').count() > 0 ||
            await page.locator('text=Excellent').count() > 0;

        if (isSuccess) {
            console.log('   🎉 Apply thành công!');
            return { success: true, status: '✅ Đã apply thành công' };
        }
        return { success: false, status: '⚠️ Cần kiểm tra thủ công' };

    } catch (e) {
        console.error(`   ❌ Lỗi apply ${job.title}:`, e.message);
        return { success: false, status: `❌ Lỗi: ${e.message.substring(0, 50)}` };
    }
}

// ====================== HÀM CHÍNH ======================
async function main() {
    // Validate inputs
    if (!DICE_EMAIL || !DICE_PASSWORD) {
        console.error('❌ Thiếu DICE_EMAIL hoặc DICE_PASSWORD');
        process.exit(1);
    }
    if (!JOBS_JSON) {
        console.error('❌ Thiếu JOBS_JSON');
        process.exit(1);
    }

    let jobs;
    try {
        jobs = JSON.parse(JOBS_JSON);
    } catch (e) {
        console.error('❌ JOBS_JSON không hợp lệ:', e.message);
        process.exit(1);
    }

    console.log(`🚀 Bắt đầu apply ${jobs.length} job...`);
    console.log('Jobs:', jobs.map(j => j.title).join(', '));

    // Download resume
    if (!RESUME_URL) {
        console.error('❌ Thiếu RESUME_URL');
        process.exit(1);
    }
    await downloadResume(RESUME_URL);
    console.log(`✅ Resume đã download: ${RESUME_PATH}`);

    // Khởi động Sheets client
    const sheets = await getSheetsClient();
    const sheetName = sheets ? await getSheetName(sheets, SHEET_GID) : null;
    if (sheetName) console.log(`📊 Sheet: "${sheetName}"`);

    // Khởi động browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const log = [];

    try {
        // Login
        const loggedIn = await loginDice(page);
        if (!loggedIn) {
            console.error('❌ Login thất bại, dừng lại');
            for (const job of jobs) {
                if (sheets && sheetName) {
                    await updateJobStatus(sheets, sheetName, job.row, '❌ Login thất bại', '#FFCDD2');
                }
                log.push({ ...job, result: 'Login failed' });
            }
            fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
            await browser.close();
            return;
        }

        // Apply từng job
        for (const job of jobs) {
            const result = await applyJob(page, job);

            log.push({
                title: job.title,
                company: job.company,
                link: job.link,
                row: job.row,
                result: result.status,
                timestamp: new Date().toISOString()
            });

            // Cập nhật Google Sheet
            if (sheets && sheetName) {
                const bgColor = result.success ? '#C8E6C9' : result.status.includes('⚠️') ? '#FFE0B2' : '#FFCDD2';
                await updateJobStatus(sheets, sheetName, job.row, result.status, bgColor);
            }

            // Uncheck checkbox sau khi xử lý
            if (sheets && sheetName) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${sheetName}!H${job.row}`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [[false]] }
                });
            }

            // Delay giữa các job
            await page.waitForTimeout(3000);
        }

    } finally {
        await browser.close();
        fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
        console.log('\n📋 KẾT QUẢ:');
        log.forEach(j => console.log(`  ${j.result} | ${j.title} @ ${j.company}`));
        console.log(`\n✅ Xong! Log đã lưu: ${LOG_PATH}`);
    }
}

main().catch(console.error);