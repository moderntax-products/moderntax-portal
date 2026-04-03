// =====================================================
// IRS BATCH TRANSCRIPT UPLOADER v6.6 — DIRECT-TO-PORTAL
// =====================================================
// Run on the IRS SOR inbox page. Automatically:
//   1. Logs you into ModernTax (email + password, cached for session)
//   2. Fetches your active assignments
//   3. Processes each transcript in the inbox
//   4. Skips transcripts that don't match your assignments
//   5. Uploads matched transcripts directly to the portal
//   6. Runs compliance screening with auto-upsell emails
// Works on Windows, Mac, Linux — any browser.
// =====================================================

(async function() {
    // ---- CONFIGURATION ----
    const PORTAL_URL = 'https://portal.moderntax.io';
    const SUPABASE_URL = 'https://nixzwnfjglojemozlvmf.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5peHp3bmZqZ2xvamVtb3psdm1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc5NjMzMzMsImV4cCI6MjA3MzUzOTMzM30.qx8VUmL9EDlxtCNj4CF04Ld9xCFWDugNHhAmV0ixfuQ';

    // ---- AUTH: Login with email/password (cached for session) ----
    let AUTH_TOKEN = window.__MT_TOKEN || '';

    if (!AUTH_TOKEN) {
        const email = prompt('ModernTax Expert Login\n\nEmail:');
        if (!email) { alert('Email required.'); return; }
        const password = prompt('Password:');
        if (!password) { alert('Password required.'); return; }

        try {
            const loginResp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                },
                body: JSON.stringify({ email, password }),
            });

            if (!loginResp.ok) {
                const err = await loginResp.json();
                alert(`Login failed: ${err.error_description || err.msg || 'Invalid credentials'}`);
                return;
            }

            const loginData = await loginResp.json();
            AUTH_TOKEN = loginData.access_token;
            window.__MT_TOKEN = AUTH_TOKEN;
            console.log('%c✅ Logged in successfully ', 'background:#38a169;color:white;padding:3px');
        } catch (e) {
            alert(`Login error: ${e.message}`);
            return;
        }
    } else {
        console.log('%c✅ Using cached session ', 'background:#38a169;color:white;padding:3px');
    }

    if (!location.href.includes('list_mail')) {
        alert('⚠️ Run this on the IRS SOR Inbox page!\n\nGo to: Secure Object Repository → Inbox');
        return;
    }

    const delay = ms => new Promise(r => setTimeout(r, ms));

    // ---- Load dependencies ----
    async function loadScript(url, checkGlobal) {
        if (window[checkGlobal]) return;
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(s);
        });
    }

    try {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', 'html2canvas');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'jspdf');
        console.log('%c✅ PDF libraries loaded ', 'background:#38a169;color:white;padding:3px');
    } catch (e) {
        alert('Failed to load PDF libraries.\n' + e.message);
        return;
    }

    const { jsPDF } = window.jspdf;

    // ---- Verify expert identity & get assignments ----
    let expertInfo;
    try {
        const resp = await fetch(`${PORTAL_URL}/api/expert/batch-upload`, {
            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` }
        });
        if (!resp.ok) {
            const err = await resp.json();
            alert(`Auth failed: ${err.error}\n\nTry closing this tab and running the script again.`);
            window.__MT_TOKEN = '';
            return;
        }
        expertInfo = await resp.json();
    } catch (e) {
        alert(`Cannot connect to ModernTax portal: ${e.message}\n\nCheck your internet connection and try again.`);
        return;
    }

    if (expertInfo.assignments.length === 0) {
        alert('✅ No active assignments!\n\nCheck the ModernTax portal for new assignments.');
        return;
    }

    // Build lookup for fast matching: TIN last 4 + first 3 chars of name
    const assignmentLookup = [];
    expertInfo.assignments.forEach(a => {
        const cleanTin = (a.tin || '').replace(/[\s-]/g, '');
        const tinLast4 = cleanTin.length >= 4 ? cleanTin.slice(-4) : '';
        const namePrefix = (a.entityName || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
        assignmentLookup.push({ tinLast4, namePrefix, entityName: a.entityName, formType: a.formType });
    });
    const assignmentTins = new Set(assignmentLookup.map(a => a.tinLast4).filter(Boolean));

    console.log(`%c👤 Expert: ${expertInfo.expert.name} | ${expertInfo.assignments.length} assignments `, 'background:#1e3a5f;color:white;padding:5px');

    // ---- Get all message links ----
    // Debug: log ALL links on the page so we can understand the IRS SOR structure
    const allPageLinks = document.querySelectorAll('a');
    console.log(`[IRS-DEBUG] Page has ${allPageLinks.length} total links. First 40:`);
    allPageLinks.forEach((a, idx) => {
        if (idx < 40) console.log(`[IRS-DEBUG]   Link ${idx}: href="${a.href}" text="${a.textContent.trim().substring(0,60)}" onclick="${(a.getAttribute('onclick')||'').substring(0,80)}"`);
    });

    const seen = new Set();
    const messages = [];

    // Strategy A: Find links with read_content, itemId, or mailId in href
    let links = document.querySelectorAll('a[href*="read_content"], a[href*="itemId"], a[href*="mailId"]');
    console.log(`[IRS-DEBUG] Strategy A (read_content/itemId/mailId links): ${links.length} found`);

    links.forEach(link => {
        const match = link.href.match(/(?:itemId|mailId)=(\d+)/);
        if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            // Walk the DOM to find the subject text (might be in a sibling cell)
            const row = link.closest('tr');
            const subjectCell = row?.querySelector('td a[href*="read_content"], td a[href*="itemId"]');
            const subject = subjectCell?.textContent?.trim() || link.textContent.trim();
            messages.push({ id: match[1], subject, href: link.href });
            console.log(`[IRS-DEBUG]   Found message: id=${match[1]} subject="${subject.substring(0,60)}" href="${link.href}"`);
        }
    });

    // Strategy B: Find "Read" action links and extract the actual URL
    if (messages.length === 0) {
        console.log(`[IRS-DEBUG] Strategy A found 0 messages. Trying Strategy B (action links)...`);
        const actionLinks = document.querySelectorAll('a');
        actionLinks.forEach(link => {
            const text = link.textContent.trim();
            if (text === 'Read' || text === 'View' || text.includes('Read')) {
                console.log(`[IRS-DEBUG]   Read link: href="${link.href}" onclick="${link.getAttribute('onclick') || ''}"`);
                const match = link.href.match(/(?:itemId|mailId|id)=(\d+)/);
                if (match && !seen.has(match[1])) {
                    seen.add(match[1]);
                    // Get subject from the same row
                    const row = link.closest('tr');
                    const cells = row?.querySelectorAll('td') || [];
                    let subject = '';
                    cells.forEach(cell => {
                        const t = cell.textContent.trim();
                        if (t.includes('TDS') || t.includes('Transaction') || t.length > 30) {
                            subject = subject || t;
                        }
                    });
                    messages.push({ id: match[1], subject: subject || text, href: link.href });
                }
            }
        });
    }

    // Strategy C: Find subject text links (TDS Transaction...) and extract their row's Read link
    if (messages.length === 0) {
        console.log(`[IRS-DEBUG] Strategy B found 0 messages. Trying Strategy C (TDS subject links)...`);
        const tdsList = document.querySelectorAll('td, a');
        tdsList.forEach(el => {
            const text = el.textContent.trim();
            if (text.includes('TDS Transaction') && !seen.has(text)) {
                const row = el.closest('tr');
                if (row) {
                    const readLink = row.querySelector('a[href*="read"], a[href*="mail"], a[href*="item"]');
                    if (readLink) {
                        const idMatch = readLink.href.match(/(\d+)/);
                        if (idMatch && !seen.has(idMatch[1])) {
                            seen.add(idMatch[1]);
                            seen.add(text);
                            messages.push({ id: idMatch[1], subject: text.substring(0, 80), href: readLink.href });
                            console.log(`[IRS-DEBUG]   Found via TDS: id=${idMatch[1]} href="${readLink.href}"`);
                        }
                    }
                }
            }
        });
    }

    // Strategy D: Fallback — try all table links with numeric IDs
    if (messages.length === 0) {
        console.log(`[IRS-DEBUG] Strategy C found 0 messages. Trying Strategy D (all table links)...`);
        const allLinks = document.querySelectorAll('table a[href], .inbox a[href], #mailList a[href]');
        allLinks.forEach(link => {
            const match = link.href.match(/(\d{5,})/);
            if (match && !seen.has(match[1]) && link.textContent.trim().length > 3) {
                seen.add(match[1]);
                messages.push({ id: match[1], subject: link.textContent.trim(), href: link.href });
            }
        });
    }

    if (messages.length === 0) {
        alert('❌ No transcripts found in inbox.\n\nMake sure you are on the IRS SOR Inbox page with messages visible.\n\nCheck the Console tab (F12) for [IRS-DEBUG] details.');
        return;
    }

    console.log(`%c📬 Found ${messages.length} messages in inbox `, 'background:#1e3a5f;color:white;padding:5px;font-weight:bold');
    messages.forEach((m, i) => console.log(`[IRS-DEBUG]   [${i}] id=${m.id} href="${m.href}" subject="${m.subject.substring(0,60)}"`));

    // ---- Progress panel ----
    document.getElementById('irs-batch')?.remove();
    const panel = document.createElement('div');
    panel.id = 'irs-batch';
    panel.innerHTML = `
        <style>
            #irs-batch { position:fixed; top:10px; right:10px; width:540px; background:#1e3a5f; color:white; padding:20px; border-radius:10px; font-family:system-ui; font-size:13px; z-index:999999; box-shadow:0 8px 30px rgba(0,0,0,0.4); max-height:85vh; overflow-y:auto; }
            #irs-batch h3 { margin:0 0 5px; color:#90cdf4; }
            #irs-batch .expert-info { color:#68d391; font-size:12px; margin-bottom:12px; }
            #irs-batch .progress { background:#2d3748; border-radius:5px; height:24px; margin:10px 0; }
            #irs-batch .progress-bar { background:linear-gradient(90deg,#4299e1,#38a169); height:100%; border-radius:5px; transition:width 0.3s; display:flex; align-items:center; justify-content:center; font-weight:600; }
            #irs-batch .log { background:#1a202c; padding:10px; border-radius:5px; max-height:400px; overflow-y:auto; font-family:monospace; font-size:11px; margin-top:10px; }
            #irs-batch .success { color:#68d391; }
            #irs-batch .error { color:#fc8181; }
            #irs-batch .info { color:#90cdf4; }
            #irs-batch .warn { color:#f6e05e; }
            #irs-batch .upload { color:#b794f4; }
            #irs-batch .controls { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
            #irs-batch button { color:white; border:none; padding:10px 16px; border-radius:5px; cursor:pointer; font-weight:600; }
            #irs-batch .btn-cancel { background:#e53e3e; }
            #irs-batch .btn-toggle { background:#4a5568; font-size:11px; padding:6px 12px; }
            #irs-batch .btn-toggle.active { background:#38a169; }
            #irs-batch .stats { display:flex; gap:12px; margin:10px 0; }
            #irs-batch .stat { background:#2d3748; padding:8px 12px; border-radius:6px; text-align:center; flex:1; }
            #irs-batch .stat-num { font-size:20px; font-weight:700; color:#68d391; }
            #irs-batch .stat-label { font-size:10px; color:#a0aec0; text-transform:uppercase; }
            #irs-batch .stat-num.red { color:#fc8181; }
        </style>
        <h3>📥 ModernTax Transcript Uploader v6.6</h3>
        <div class="expert-info">👤 ${expertInfo.expert.name} • ${expertInfo.assignments.length} assignments • ${messages.length} messages in inbox</div>
        <div style="background:#2d3748;border-radius:5px;padding:8px 12px;margin-bottom:8px;font-size:11px;">
            <div style="color:#a0aec0;margin-bottom:4px;">Looking for these entities:</div>
            ${expertInfo.assignments.map(a => `<div style="color:#68d391;">• ${a.entityName} — ${a.formType} — TIN ending ***${(a.tin || '').replace(/[\s-]/g, '').slice(-4) || '????'}${a.entityTranscriptRequested ? ' <span style="color:#90cdf4;font-weight:bold;">[+Entity Transcript]</span>' : ''}${a.filingRequirements ? ` <span style="color:#f6e05e;">[Filing: ${a.filingRequirements}]</span>` : ''}</div>`).join('')}
        </div>
        <div>Processing <strong id="irs-curr">0</strong> / <strong>${messages.length}</strong> messages <span id="irs-status" style="color:#f6e05e;"></span></div>
        <div class="progress"><div class="progress-bar" id="irs-pbar" style="width:0%">0%</div></div>
        <div class="stats">
            <div class="stat"><div class="stat-num" id="irs-uploaded">0</div><div class="stat-label">Uploaded</div></div>
            <div class="stat"><div class="stat-num" id="irs-skipped">0</div><div class="stat-label">Not Yours</div></div>
            <div class="stat"><div class="stat-num" id="irs-failed">0</div><div class="stat-label red">Failed</div></div>
            <div class="stat"><div class="stat-num" id="irs-critical">0</div><div class="stat-label">Flags</div></div>
        </div>
        <div class="controls">
            <button class="btn-toggle" id="irs-local-toggle" onclick="window.irsAlsoLocal=!window.irsAlsoLocal;this.textContent=window.irsAlsoLocal?'💾 +Local ON':'💾 +Local OFF';this.classList.toggle('active')">💾 +Local OFF</button>
            <button class="btn-cancel" onclick="window.irsCancel=true;this.textContent='Cancelling...'">Cancel</button>
        </div>
        <div class="log" id="irs-log"></div>
    `;
    document.body.appendChild(panel);

    const log = document.getElementById('irs-log');
    const addLog = (msg, cls='info') => {
        log.innerHTML += `<div class="${cls}">${msg}</div>`;
        log.scrollTop = log.scrollHeight;
    };

    window.irsCancel = false;
    window.irsAlsoLocal = false;

    let uploadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let criticalCount = 0;

    // ---- Hidden render container ----
    const renderContainer = document.createElement('div');
    renderContainer.id = 'irs-render';
    renderContainer.style.cssText = 'position:fixed; left:-9999px; top:0; width:850px; background:white; z-index:-1;';
    document.body.appendChild(renderContainer);

    // ==========================================================
    // COMPLIANCE SCREENING ENGINE
    // ==========================================================

    function screenTranscript(htmlString, metadata) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        const fullText = doc.body?.textContent || '';

        const finding = {
            taxpayerName: metadata.name || '',
            tin: metadata.tin || '',
            formType: metadata.formType || '',
            taxYear: metadata.taxYear || '',
            transcriptType: metadata.shortType || '',
            isBlank: false,
            hasBalanceDue: false,
            severity: 'CLEAN',
            flags: [],
            grossReceipts: null,
            totalIncome: null,
            totalDeductions: null,
            totalTax: null,
            accountBalance: null,
            accruedInterest: null,
            accruedPenalty: null,
            accountBalancePlusAccruals: null,
            transactionCodes: [],
        };

        if (fullText.match(/No record of return filed/i) || fullText.match(/No transcript available/i)) {
            finding.isBlank = true;
            finding.severity = 'CRITICAL';
            finding.flags.push({ type: 'UNFILED', severity: 'CRITICAL', message: `No record of return filed for ${metadata.taxYear}` });
            return finding;
        }

        function extractField(text, regex) {
            const m = text.match(regex);
            if (!m) return null;
            return parseFloat(m[1].replace(/,/g, ''));
        }

        finding.grossReceipts = extractField(fullText, /GROSS RECEIPTS[^:]*:\s*\$([\d,.]+)/);
        finding.totalIncome = extractField(fullText, /TOTAL INCOME[^:]*:\s*\$([\d,.]+)/);
        finding.totalDeductions = extractField(fullText, /TOTAL DEDUCTIONS[^:]*:\s*\$([\d,.]+)/);
        finding.totalTax = extractField(fullText, /TOTAL TAX[^:]*:\s*\$([\d,.]+)/);
        finding.accountBalance = extractField(fullText, /ACCOUNT BALANCE:\s*\$([\d,.]+)/);
        finding.accruedInterest = extractField(fullText, /ACCRUED INTEREST:\s*\$([\d,.]+)/);
        finding.accruedPenalty = extractField(fullText, /ACCRUED PENALTY:\s*\$([\d,.]+)/);
        finding.accountBalancePlusAccruals = extractField(fullText, /ACCOUNT BALANCE PLUS ACCRUALS:\s*\$([\d,.]+)/);

        const tcRegex = /(\d{3})\s+(.+?)\s+(\d{2}-\d{2}-\d{4})\s+(\$[\d,.]+|-?\$[\d,.]+)?/g;
        let tcMatch;
        while ((tcMatch = tcRegex.exec(fullText)) !== null) {
            const code = parseInt(tcMatch[1]);
            finding.transactionCodes.push({
                code: tcMatch[1], explanation: tcMatch[2].trim(), date: tcMatch[3], amount: tcMatch[4] || ''
            });

            if ([582, 583].includes(code)) finding.flags.push({ type: 'LIEN', severity: 'CRITICAL', message: `Federal tax lien (TC ${code}) filed on ${tcMatch[3]}` });
            if (code === 670 && tcMatch[2]?.match(/levy/i)) finding.flags.push({ type: 'LEVY', severity: 'CRITICAL', message: `Levy action on ${tcMatch[3]}` });
            if ([420, 421].includes(code)) finding.flags.push({ type: 'AUDIT', severity: 'CRITICAL', message: `Examination initiated (TC ${code}) on ${tcMatch[3]}` });
            if (code === 150 && tcMatch[2]?.match(/substitute/i)) finding.flags.push({ type: 'SFR', severity: 'CRITICAL', message: `IRS filed Substitute for Return on ${tcMatch[3]}` });
            if ([520, 530].includes(code)) finding.flags.push({ type: 'COLLECTION', severity: 'CRITICAL', message: `Collection action (TC ${code}) on ${tcMatch[3]}` });
            if (code === 971 && tcMatch[2]?.match(/installment/i)) finding.flags.push({ type: 'INSTALLMENT', severity: 'WARNING', message: `Installment agreement on ${tcMatch[3]}` });
            if ([480, 481].includes(code)) finding.flags.push({ type: 'OIC', severity: 'WARNING', message: `Offer in Compromise (TC ${code}) on ${tcMatch[3]}` });
        }

        const effectiveBalance = finding.accountBalancePlusAccruals ?? finding.accountBalance;
        if (effectiveBalance !== null && effectiveBalance > 0) {
            finding.flags.push({
                type: 'BALANCE_DUE', severity: 'CRITICAL',
                message: `Outstanding balance: $${effectiveBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            });
        }

        const severities = finding.flags.map(f => f.severity);
        if (severities.includes('CRITICAL')) finding.severity = 'CRITICAL';
        else if (severities.includes('WARNING')) finding.severity = 'WARNING';
        else finding.severity = 'CLEAN';

        return finding;
    }

    // ---- HTML to PDF ----
    async function htmlToPdfBlob(htmlString, filename, quality) {
        quality = quality || 0.72;
        renderContainer.innerHTML = htmlString;
        const styleOverride = document.createElement('style');
        styleOverride.textContent = `
            #irs-render { font-family: 'Courier New', monospace; font-size: 11px; color: #000; }
            #irs-render * { max-width: 830px !important; overflow-wrap: break-word; }
            #irs-render table { width: 100% !important; border-collapse: collapse; }
            #irs-render td, #irs-render th { padding: 2px 4px; border: 1px solid #ccc; font-size: 10px; }
        `;
        renderContainer.appendChild(styleOverride);
        await delay(300);

        const canvas = await html2canvas(renderContainer, {
            scale: 1.5, useCORS: true, logging: false, width: 850, windowWidth: 850, backgroundColor: '#ffffff'
        });

        const imgWidth = 210;
        const pageHeight = 297;
        const margin = 10;
        const contentWidth = imgWidth - (margin * 2);
        const imgHeight = (canvas.height * contentWidth) / canvas.width;

        const pdf = new jsPDF('p', 'mm', 'a4');
        let heightLeft = imgHeight;
        let position = margin;
        const imgData = canvas.toDataURL('image/jpeg', quality);

        pdf.addImage(imgData, 'JPEG', margin, position, contentWidth, imgHeight);
        heightLeft -= (pageHeight - margin * 2);

        while (heightLeft > 0) {
            position = -(pageHeight - margin * 2) * (Math.ceil((imgHeight - heightLeft) / (pageHeight - margin * 2))) + margin;
            pdf.addPage();
            pdf.addImage(imgData, 'JPEG', margin, position, contentWidth, imgHeight);
            heightLeft -= (pageHeight - margin * 2);
        }

        pdf.setProperties({ title: filename, creator: 'ModernTax v6.6' });
        renderContainer.innerHTML = '';
        return pdf.output('blob');
    }

    // ---- Download helper ----
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    const results = [];
    const allFindings = [];

    // ==========================================================
    // MAIN PROCESSING LOOP
    // ==========================================================

    for (let i = 0; i < messages.length; i++) {
        if (window.irsCancel) { addLog('🛑 Cancelled by user', 'error'); break; }

        const msg = messages[i];
        document.getElementById('irs-curr').textContent = i + 1;
        const pct = Math.round((i + 1) / messages.length * 100);
        document.getElementById('irs-pbar').style.width = pct + '%';
        document.getElementById('irs-pbar').textContent = pct + '%';
        document.getElementById('irs-status').textContent = '⏳ working...';

        addLog(`\n[${i+1}/${messages.length}] ${msg.subject.substring(0,60)}`);

        try {
            // ---- Transcript Detection Helper ----
            const looksLikeTranscript = (html) => {
                if (!html || html.length < 200) return false;
                const markers = [
                    'transcript-title', 'item-container',
                    'Tax Return Transcript', 'Account Transcript',
                    'Wage and Income', 'Record of Account',
                    'Entity Transcript', 'No record of return filed',
                    'Form Number', 'Taxpayer Identification',
                    'RETURN TRANSCRIPT', 'ACCOUNT TRANSCRIPT',
                    'RECORD OF ACCOUNT', 'Filing Status',
                    'FORM W-2', 'WAGE AND INCOME',
                    'TRANSACTION CODE', 'TAX PERIOD',
                    'Adjusted Gross Income', 'Total Income',
                    'Business Name', 'Principal Business',
                    'transcript_data', 'ENTITY TRANSCRIPT',
                    'Return Filed', 'INCOME TAX RETURN',
                ];
                return markers.some(m => html.includes(m));
            };

            const useJsp = location.href.includes('.jsp');
            const jspExt = useJsp ? '.jsp' : '';
            let transcriptHtml = '';
            let readHtml = '';

            // ================================================================
            // STRATEGY 1: Follow the actual "Read" link from the inbox page
            // The IRS SOR assigns session-scoped IDs. We must use the exact
            // href from the inbox link, not construct URLs from mailId alone.
            // After clicking "Read", the page shows the message + attachment.
            // ================================================================
            const messageHref = msg.href || '';
            console.log(`[IRS-DEBUG] Msg ${msg.id}: using href="${messageHref}"`);

            // Navigate to the message's read page (using actual href from inbox)
            if (messageHref) {
                if (i === 0) {
                    addLog(`  ⏳ Starting IRS session...`, 'warn');
                    await fetch(messageHref, { credentials: 'include' });
                    await delay(2000);
                }

                const readResp = await fetch(messageHref, { credentials: 'include' });
                readHtml = await readResp.text();
                console.log(`[IRS-DEBUG] Msg ${msg.id} href response (${readHtml.length} chars):`, readHtml.substring(0, 2000));
                await delay(800);

                // Check if the read page itself is the transcript
                if (looksLikeTranscript(readHtml)) {
                    transcriptHtml = readHtml;
                    console.log(`[IRS-DEBUG] Msg ${msg.id}: read page IS the transcript`);
                }
            }

            // Also try the standard read_content URL
            if (!transcriptHtml) {
                const readUrl = `/semail/views/read_content${jspExt}?mailId=${msg.id}`;
                try {
                    const readResp2 = await fetch(readUrl, { credentials: 'include' });
                    const readHtml2 = await readResp2.text();
                    console.log(`[IRS-DEBUG] Msg ${msg.id} read_content (${readHtml2.length} chars):`, readHtml2.substring(0, 2000));
                    if (readHtml2.length > readHtml.length) readHtml = readHtml2;
                    if (looksLikeTranscript(readHtml2)) {
                        transcriptHtml = readHtml2;
                    }
                } catch (e) { /* continue */ }
                await delay(500);
            }

            // ================================================================
            // STRATEGY 2: Parse the read page for attachment/iframe/download links
            // The message page embeds the transcript in an iframe or provides
            // download links. Extract and try each one.
            // ================================================================
            if (!transcriptHtml && readHtml.length > 200) {
                // Extract ALL URLs from the page (href, src, onclick, etc.)
                const linkMatches = readHtml.match(/(?:href|src|action)=["']([^"']+)["']/gi) || [];
                const allUrls = linkMatches.map(m => m.replace(/^(?:href|src|action)=["']/i, '').replace(/["']$/, ''));

                // Also find URLs in onclick/javascript
                const jsUrlMatches = readHtml.match(/(?:window\.open|location\.href|window\.location)\s*[=(]\s*['"]([^'"]+)['"]/gi) || [];
                jsUrlMatches.forEach(m => {
                    const url = m.replace(/^.*[=(]\s*['"]/, '').replace(/['"]$/, '');
                    allUrls.push(url);
                });

                console.log(`[IRS-DEBUG] Msg ${msg.id} found ${allUrls.length} URLs in read page:`, allUrls.filter(u => !u.startsWith('#') && !u.includes('javascript:')).slice(0, 20));

                // Try attachment-like URLs
                const attachUrls = allUrls.filter(url =>
                    url.includes('FileDownload') || url.includes('view_file') ||
                    url.includes('attachment') || url.includes('download') ||
                    url.includes('index=') || (url.endsWith('.html') || url.endsWith('.htm'))
                );
                console.log(`[IRS-DEBUG] Msg ${msg.id} attachment URLs:`, attachUrls);

                for (const attachUrl of attachUrls) {
                    try {
                        const fullUrl = attachUrl.startsWith('http') ? attachUrl
                            : attachUrl.startsWith('/') ? attachUrl
                            : '/' + attachUrl;
                        const resp = await fetch(fullUrl, { credentials: 'include' });
                        const html = await resp.text();
                        console.log(`[IRS-DEBUG] Msg ${msg.id} attachment "${fullUrl.substring(0,80)}": ${html.length} chars`);
                        if (looksLikeTranscript(html)) {
                            transcriptHtml = html;
                            addLog(`  📎 Found transcript in attachment`, 'info');
                            break;
                        }
                    } catch (e) { /* continue */ }
                    await delay(300);
                }
            }

            // ================================================================
            // STRATEGY 3: Try view_file with multiple indices & extensions
            // ================================================================
            if (!transcriptHtml) {
                for (const idx of [0, 1, 2]) {
                    if (transcriptHtml) break;
                    for (const ext of ['html', 'htm', 'xml', '']) {
                        if (transcriptHtml) break;
                        const extParam = ext ? `&ext=${ext}` : '';
                        const viewUrl = `/semail/views/view_file${jspExt}?mailId=${msg.id}&index=${idx}${extParam}&action=view`;
                        try {
                            const resp = await fetch(viewUrl, { credentials: 'include' });
                            const html = await resp.text();
                            if (html.length > 200) {
                                console.log(`[IRS-DEBUG] Msg ${msg.id} view_file idx=${idx} ext=${ext||'none'}: ${html.length} chars`);
                            }
                            if (looksLikeTranscript(html)) {
                                transcriptHtml = html;
                                addLog(`  📎 Found transcript (attachment ${idx}, ${ext || 'auto'})`, 'info');
                            }
                        } catch (e) { /* continue */ }
                        await delay(200);
                    }
                }
            }

            // ================================================================
            // STRATEGY 4: Classic FileDownload — set session via href, then download
            // ================================================================
            if (!transcriptHtml) {
                // Re-navigate to message to set session
                if (messageHref) {
                    await fetch(messageHref, { credentials: 'include' });
                    await delay(1500);
                }

                for (const dlUrl of [
                    '/semail/servlet/FileDownload',
                    `/semail/servlet/FileDownload?mailId=${msg.id}`,
                    `/semail/servlet/FileDownload?mailId=${msg.id}&index=0`,
                ]) {
                    try {
                        const resp = await fetch(dlUrl, { credentials: 'include' });
                        const html = await resp.text();
                        console.log(`[IRS-DEBUG] Msg ${msg.id} FileDownload "${dlUrl}": ${html.length} chars`);
                        if (looksLikeTranscript(html)) {
                            transcriptHtml = html;
                            addLog(`  📎 Found transcript via FileDownload`, 'info');
                            break;
                        }
                    } catch (e) { /* continue */ }
                    await delay(300);
                }
            }

            // Log comprehensive failure details
            if (!transcriptHtml) {
                console.log(`[IRS-DEBUG] Msg ${msg.id} ALL STRATEGIES FAILED.`);
                console.log(`[IRS-DEBUG] Msg ${msg.id} full read page HTML:`, readHtml);
            }

            if (transcriptHtml && looksLikeTranscript(transcriptHtml)) {

                const parser = new DOMParser();
                const doc = parser.parseFromString(transcriptHtml, 'text/html');
                const fullText = doc.body?.textContent || '';
                const titleText = doc.querySelector('title')?.textContent || '';

                // Get transcript type
                const titleEl = doc.querySelector('h1.transcript-title') || doc.querySelector('h2') || doc.querySelector('h3 b');
                let transcriptType = titleEl?.textContent?.trim() || titleText || 'Transcript';
                let shortType = 'Transcript';
                let isEntityTranscript = false;
                if (transcriptType.match(/Entity Transcript/i) || fullText.match(/Entity Transcript for Business/i)) {
                    shortType = 'Entity Transcript';
                    isEntityTranscript = true;
                }
                else if (transcriptType.match(/Return Transcript/i)) shortType = 'Return Transcript';
                else if (transcriptType.match(/Account Transcript/i)) shortType = 'Account Transcript';
                else if (transcriptType.match(/Record of Account/i)) shortType = 'Record of Account';
                else if (transcriptType.match(/Wage and Income/i)) shortType = 'Wage and Income';

                // Extract metadata: form, TIN, year, name
                let formType = '', tin = '', taxYear = '', taxpayerName = '';
                let entityData = null; // Extra data for Entity Transcripts

                const items = doc.querySelectorAll('.item-container');
                items.forEach(item => {
                    const label = item.querySelector('.item-label')?.textContent?.trim() || '';
                    const value = item.querySelector('.item-value')?.textContent?.trim() || '';
                    if (label === 'Form Number:' || label === 'Form:') formType = value;
                    if (label.includes('Taxpayer Identification Number')) tin = value;
                    if (label.match(/Tax Period|Report for Tax Period/i)) {
                        const m = value.match(/(\d{4})/);
                        if (m) taxYear = m[1];
                    }
                    if (label && !value && label.length > 2 && label.length < 60 &&
                        !label.includes(':') && !label.match(/^(Original|Duplicate|\d|FUDGE|1016)/)) {
                        if (!taxpayerName) taxpayerName = label;
                    }
                });

                // Entity Transcript special handling
                if (isEntityTranscript) {
                    formType = 'BMF_ENTITY';
                    entityData = {};
                    // Parse Entity Transcript fields from the IRS HTML
                    // These use table layout with bold labels and value cells
                    const allCells = doc.querySelectorAll('td');
                    for (let c = 0; c < allCells.length; c++) {
                        const cellText = allCells[c].textContent.trim();
                        const nextCell = allCells[c + 1];
                        const nextVal = nextCell?.textContent?.trim() || '';
                        if (cellText.match(/EIN.*Provided/i) || cellText.match(/Employer Identification/i)) { if (!tin) tin = nextVal; }
                        if (cellText.match(/^Primary Name/i)) { if (!taxpayerName) taxpayerName = nextVal; entityData.primaryName = nextVal; }
                        if (cellText.match(/^Filing Requirements/i)) entityData.filingRequirements = nextVal;
                        if (cellText.match(/^NAICS/i) || cellText.match(/Industry Classification/i)) entityData.naicsCode = nextVal;
                        if (cellText.match(/^IRS Establishment/i)) entityData.establishmentDate = nextVal;
                        if (cellText.match(/^Business Operational/i)) entityData.operationalDate = nextVal;
                        if (cellText.match(/^Business Close/i) && nextVal) entityData.closeDate = nextVal;
                        if (cellText.match(/^Street Address/i)) entityData.address = nextVal;
                        if (cellText.match(/^City:/i)) entityData.city = nextVal;
                        if (cellText.match(/^State:/i)) entityData.state = nextVal;
                        if (cellText.match(/^ZIP Code/i)) entityData.zipCode = nextVal;
                        if (cellText.match(/^Fiscal Year Month/i) && !cellText.match(/Prior/i)) entityData.fiscalYearMonth = nextVal;
                        if (cellText.match(/^Business Operating Division/i)) entityData.division = nextVal;
                        if (cellText.match(/^Name Control/i)) entityData.nameControl = nextVal;
                    }
                    // Entity transcripts don't have a tax year — use current year
                    if (!taxYear) taxYear = new Date().getFullYear().toString();
                    // Extract EIN from full text fallback
                    if (!tin) {
                        const einMatch = fullText.match(/EIN\)?.*?:\s*([\d-]+)/i);
                        if (einMatch) tin = einMatch[1];
                    }
                }

                // For 941 Account Transcripts, preserve form as "941" (not the entity's primary form)
                const is941 = formType === '941' || formType === '940';
                if (is941) {
                    // Extract period ending for 941 quarterly naming
                    const periodItems = doc.querySelectorAll('.item-container');
                    periodItems.forEach(item => {
                        const label = item.querySelector('.item-label')?.textContent?.trim() || '';
                        const value = item.querySelector('.item-value')?.textContent?.trim() || '';
                        if (label.match(/Report for Tax Period/i)) {
                            // Use full date for quarterly (e.g. "09-30-2025")
                            if (!taxYear) {
                                const ym = value.match(/(\d{2}-\d{2}-\d{4})/);
                                if (ym) taxYear = ym[1];
                                else { const y = value.match(/(\d{4})/); if (y) taxYear = y[1]; }
                            }
                        }
                    });
                }

                // Old IRS format fallback
                if (!formType || !tin || !taxYear) {
                    const allBolds = doc.querySelectorAll('b, strong');
                    allBolds.forEach(b => {
                        const label = b.textContent.trim();
                        const nextTd = b.closest('td')?.nextElementSibling;
                        const value = nextTd?.textContent?.trim() || '';
                        if (label.match(/Form Number/i)) formType = formType || value;
                        if (label.match(/EIN Provided|SSN Provided|Taxpayer Identification/i)) tin = tin || value;
                        if (label.match(/Tax Period/i)) {
                            const m = value.match(/(\d{4})/);
                            if (m) taxYear = taxYear || m[1];
                        }
                    });
                    if (!formType) {
                        const m = titleText.match(/(?:Tax Return Transcript|Account Transcript)\s*(?:--\s*)?(\d{4}[A-Z]?)/);
                        if (m) formType = m[1];
                    }
                    if (!taxYear) {
                        const m = titleText.match(/(\d{6})/);
                        if (m) taxYear = m[1].substring(0, 4);
                    }
                    if (!taxpayerName) {
                        const m = fullText.match(/NAME\(S\) SHOWN ON RETURN:\s*(.+?)(?:\n|$)/);
                        if (m) taxpayerName = m[1].trim();
                    }
                }

                // Extra TIN fallback: scan full text for SSN/EIN patterns
                if (!tin) {
                    const tinMatch = fullText.match(/(?:SSN|EIN|TIN|Taxpayer.*?Number)[:\s]*([*\d][\d*\s-]{6,10}\d)/i);
                    if (tinMatch) tin = tinMatch[1].trim();
                }

                // Extract TIN from the message subject (most reliable source — always present)
                if (!tin && msg.subject) {
                    const subjectTin = msg.subject.match(/TIN\s*[-–]?\s*(\d{9})/);
                    if (subjectTin) {
                        tin = subjectTin[1];
                        console.log(`[IRS-DEBUG] Msg ${msg.id}: TIN from subject: ${tin}`);
                    }
                    // Also try negative number format: TIN -455511538 (IRS sometimes prefixes with -)
                    if (!tin) {
                        const negTin = msg.subject.match(/TIN\s+[-](\d{9})/);
                        if (negTin) {
                            tin = negTin[1];
                            console.log(`[IRS-DEBUG] Msg ${msg.id}: TIN from subject (neg format): ${tin}`);
                        }
                    }
                }

                const name = taxpayerName || 'Unknown';
                const cleanName = name.substring(0, 20).replace(/[^a-zA-Z0-9 &]/g, '').trim().replace(/\s+/g, ' ');
                const baseFilename = `${cleanName} - ${formType} ${shortType} - ${taxYear}`;
                const metadata = { name, tin, formType, taxYear, shortType };

                // Debug: log all extracted metadata
                console.log(`[IRS-DEBUG] Msg ${msg.id} metadata:`, JSON.stringify({ name, tin, formType, taxYear, shortType, titleText: titleText?.substring(0,60) }));

                // ---- COMPLIANCE SCREENING ----
                const finding = screenTranscript(transcriptHtml, metadata);
                allFindings.push(finding);

                if (finding.severity === 'CRITICAL') {
                    criticalCount++;
                    document.getElementById('irs-critical').textContent = criticalCount;
                    finding.flags.filter(f => f.severity === 'CRITICAL').forEach(f => addLog(`  🔴 ${f.message}`, 'error'));
                } else if (finding.severity === 'WARNING') {
                    finding.flags.filter(f => f.severity === 'WARNING').forEach(f => addLog(`  🟡 ${f.message}`, 'warn'));
                }

                // ---- MATCH CHECK ----
                const cleanTin = (tin || '').replace(/[\s-*]/g, '');
                const tinLast4 = cleanTin.slice(-4);
                const transcriptNamePrefix = (name || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();

                console.log(`[IRS-DEBUG] Msg ${msg.id} MATCH CHECK: tinLast4="${tinLast4}" namePrefix="${transcriptNamePrefix}"`);
                console.log(`[IRS-DEBUG] Msg ${msg.id} assignments:`, assignmentLookup.map(a => `${a.entityName} TIN=***${a.tinLast4} prefix=${a.namePrefix}`));

                // Match by TIN last 4 digits OR by name prefix
                const isMatch = assignmentLookup.some(a => {
                    if (tinLast4 && a.tinLast4 && tinLast4 === a.tinLast4) return true;
                    if (transcriptNamePrefix && a.namePrefix && transcriptNamePrefix === a.namePrefix) return true;
                    return false;
                });

                if (!isMatch) {
                    // Also try matching against TIN from subject line directly
                    const subjectTinMatch = msg.subject.match(/TIN\s*[-–]?\s*(\d+)/);
                    const subjectTinLast4 = subjectTinMatch ? subjectTinMatch[1].slice(-4) : '';
                    const subjectMatch = subjectTinLast4 && assignmentLookup.some(a => a.tinLast4 === subjectTinLast4);

                    if (subjectMatch) {
                        console.log(`[IRS-DEBUG] Msg ${msg.id}: transcript TIN miss but SUBJECT TIN ***${subjectTinLast4} matches!`);
                        // Override tin with subject TIN for upload
                        tin = subjectTinMatch[1];
                    } else {
                        skippedCount++;
                        document.getElementById('irs-skipped').textContent = skippedCount;
                        addLog(`  ⏭️ Not yours — ${cleanName} (***${tinLast4 || '????'}) subject TIN ***${subjectTinLast4 || '????'}`, 'warn');
                        console.log(`[IRS-DEBUG] Msg ${msg.id} NO MATCH. TIN="${tin}" cleanTin="${cleanTin}" last4="${tinLast4}" subjectLast4="${subjectTinLast4}"`);
                        results.push({ success: false, skipped: true, reason: 'not assigned', name, tin });
                        await delay(300);
                        continue;
                    }
                }

                // ---- CONVERT TO PDF ----
                addLog(`  🔄 Converting...`, 'info');
                let pdfBlob = await htmlToPdfBlob(transcriptHtml, baseFilename + '.pdf');

                // If PDF is too large, recompress at lower quality
                if (pdfBlob.size > 3.5 * 1024 * 1024) {
                    addLog(`  🗜️ Compressing (${(pdfBlob.size / 1024 / 1024).toFixed(1)}MB)...`, 'warn');
                    pdfBlob = await htmlToPdfBlob(transcriptHtml, baseFilename + '.pdf', 0.45);
                    addLog(`  📦 Compressed to ${(pdfBlob.size / 1024 / 1024).toFixed(1)}MB`, 'info');
                }

                // ---- UPLOAD TO PORTAL (with retry) ----
                addLog(`  📤 Uploading...`, 'upload');

                const formData = new FormData();
                formData.append('file', pdfBlob, baseFilename + '.pdf');
                const uploadMetadata = {
                    tin, formType, taxYear, shortType,
                    taxpayerName: name,
                    filename: baseFilename + '.pdf',
                    compliance: finding,
                    transcriptCategory: isEntityTranscript ? 'entity' : is941 ? 'payroll' : 'income',
                };
                if (entityData) uploadMetadata.entityData = entityData;
                formData.append('metadata', JSON.stringify(uploadMetadata));

                // Also include raw HTML for webhook delivery to API clients (e.g., ClearFirm)
                try {
                    const htmlBlob = new Blob([transcriptHtml], { type: 'text/html' });
                    formData.append('htmlFile', htmlBlob, baseFilename + '.html');
                } catch (htmlErr) {
                    // Non-critical — PDF is the primary artifact
                    console.warn('Could not attach HTML:', htmlErr);
                }

                let uploaded = false;
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const uploadResp = await fetch(`${PORTAL_URL}/api/expert/batch-upload`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
                            body: formData,
                        });

                        const uploadResult = await uploadResp.json();

                        if (uploadResp.ok) {
                            if (uploadResult.duplicate) {
                                addLog(`  ⏭️ Already uploaded — skipped duplicate`, 'info');
                                uploaded = true;
                                skippedCount++;
                                document.getElementById('irs-skipped').textContent = skippedCount;
                            } else {
                                uploadedCount++;
                                document.getElementById('irs-uploaded').textContent = uploadedCount;
                                addLog(`  ✅ Uploaded → ${uploadResult.entityName || name} (${uploadResult.totalFiles || '?'} files total)`, 'success');
                            }
                            uploaded = true;
                            break;
                        } else {
                            if (attempt === 1) {
                                addLog(`  ⚠️ Upload rejected: ${uploadResult.error || 'Unknown'} — retrying...`, 'warn');
                                await delay(2000);
                            } else {
                                addLog(`  ❌ Upload failed: ${uploadResult.error || 'Unknown'}`, 'error');
                                addLog(`  💾 Saving locally as backup...`, 'info');
                                downloadBlob(pdfBlob, baseFilename + '.pdf');
                            }
                        }
                    } catch (uploadErr) {
                        if (attempt === 1) {
                            addLog(`  ⚠️ Network error — retrying...`, 'warn');
                            await delay(2000);
                        } else {
                            addLog(`  ❌ Upload failed: ${uploadErr.message}`, 'error');
                            downloadBlob(pdfBlob, baseFilename + '.pdf');
                            addLog(`  💾 Saved locally as backup`, 'info');
                        }
                    }
                }

                if (!uploaded) {
                    failedCount++;
                    document.getElementById('irs-failed').textContent = failedCount;
                }

                // Also save locally if toggle is on
                if (window.irsAlsoLocal && uploaded) {
                    downloadBlob(pdfBlob, baseFilename + '.pdf');
                }

                results.push({ success: uploaded, filename: baseFilename, name, tin, formType, taxYear, finding });

            } else {
                // Debug: show what we got
                const preview = readHtml.substring(0, 300).replace(/\s+/g, ' ').trim();
                addLog(`  ⏭️ Not a transcript — could not extract content`, 'warn');
                addLog(`     read_content: ${readHtml.length} chars`, 'warn');
                addLog(`     💡 Open Console (F12) → search [IRS-DEBUG] for full page HTML`, 'warn');
                skippedCount++;
                document.getElementById('irs-skipped').textContent = skippedCount;
                results.push({ success: false, skipped: true, reason: 'not transcript' });
            }

        } catch (err) {
            addLog(`  ❌ Error: ${err.message}`, 'error');
            failedCount++;
            document.getElementById('irs-failed').textContent = failedCount;
            results.push({ success: false, error: err.message });
        }

        await delay(1200);
    }

    // ---- Cleanup ----
    renderContainer.remove();
    document.getElementById('irs-status').textContent = '✅ Done!';

    // ---- Final Summary ----
    const ok = results.filter(r => r.success).length;
    const notAssigned = results.filter(r => r.skipped && r.reason === 'not assigned').length;
    const notTranscript = results.filter(r => r.skipped && r.reason === 'not transcript').length;
    const warnings = allFindings.filter(f => f.severity === 'WARNING').length;

    addLog(`\n${'═'.repeat(45)}`, 'info');
    addLog(`RESULTS`, 'info');
    addLog(`${'═'.repeat(45)}`, 'info');
    addLog(`📤 Uploaded to portal: ${uploadedCount}`, uploadedCount > 0 ? 'success' : 'warn');
    if (notAssigned > 0) addLog(`⏭️ Not your assignments: ${notAssigned}`, 'warn');
    if (notTranscript > 0) addLog(`📭 System messages (not transcripts): ${notTranscript}`, 'warn');
    addLog(`❌ Failed uploads: ${failedCount}`, failedCount > 0 ? 'error' : 'info');
    addLog(`🔍 Compliance flags: ${criticalCount} critical, ${warnings} warnings`, criticalCount > 0 ? 'error' : 'info');
    if (notTranscript > 0 && uploadedCount === 0) {
        addLog(`\n⚠️ Could not extract transcripts from ${notTranscript} messages.`, 'warn');
        addLog(`   This usually means the IRS changed their page format.`, 'warn');
        addLog(`   STEPS:`, 'warn');
        addLog(`   1. Open Console (F12) and search for [IRS-DEBUG]`, 'warn');
        addLog(`   2. Copy the logged HTML and send to support@moderntax.io`, 'warn');
        addLog(`   3. Try clicking one message manually to verify transcripts load`, 'warn');
        addLog(`   4. Refresh the page and try running the script again`, 'warn');
    }

    if (ok > 0) {
        addLog(`\n📁 Uploaded transcripts:`, 'info');
        const byName = {};
        results.filter(r => r.success).forEach(r => {
            if (!byName[r.name]) byName[r.name] = [];
            byName[r.name].push(r);
        });
        Object.keys(byName).forEach(n => {
            addLog(`  ${n}:`, 'success');
            byName[n].forEach(r => addLog(`    • ${r.formType} ${r.taxYear} ${r.finding?.severity === 'CRITICAL' ? '🔴' : r.finding?.severity === 'WARNING' ? '🟡' : '✅'}`, 'success'));
        });
    }

    if (failedCount > 0) {
        addLog(`\n⚠️ ${failedCount} transcripts failed to upload but were saved to your Downloads folder.`, 'warn');
        addLog(`You can manually upload them in the ModernTax portal.`, 'warn');
    }

    // Simple, clear final alert
    let summary = `Done! ${uploadedCount} transcript${uploadedCount !== 1 ? 's' : ''} uploaded to ModernTax.`;
    if (skippedCount > 0) summary += `\n${skippedCount} skipped (not in your assignments).`;
    if (failedCount > 0) summary += `\n${failedCount} failed (saved to Downloads — upload manually in portal).`;
    if (criticalCount > 0) summary += `\n\n⚠️ ${criticalCount} compliance flag${criticalCount !== 1 ? 's' : ''} found — check the log.`;
    alert(summary);

    return { results, findings: allFindings, uploaded: uploadedCount, failed: failedCount, skipped: skippedCount };
})();
