// =====================================================
// IRS BATCH TRANSCRIPT UPLOADER v6 — DIRECT-TO-PORTAL
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
            console.log('%c Logged in successfully ', 'background:#38a169;color:white;padding:3px');
        } catch (e) {
            alert(`Login error: ${e.message}`);
            return;
        }
    }

    if (!location.href.includes('list_mail')) {
        alert('Run this on the IRS Inbox page!');
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
        console.log('%c Dependencies loaded ', 'background:#38a169;color:white;padding:3px');
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
            alert(`Auth failed: ${err.error}\n\nTry logging out and back in.`);
            window.__MT_TOKEN = '';
            return;
        }
        expertInfo = await resp.json();
    } catch (e) {
        alert(`Cannot connect to portal: ${e.message}`);
        return;
    }

    if (expertInfo.assignments.length === 0) {
        alert('You have no active assignments. Check the portal for new assignments.');
        return;
    }

    // Build lookup for fast matching: TIN last 4 + first 3 chars of name
    // IRS transcripts mask TINs so only last 4 digits are visible
    const assignmentLookup = [];
    expertInfo.assignments.forEach(a => {
        const cleanTin = (a.tin || '').replace(/[\s-]/g, '');
        const tinLast4 = cleanTin.length >= 4 ? cleanTin.slice(-4) : '';
        const namePrefix = (a.entityName || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
        assignmentLookup.push({ tinLast4, namePrefix, entityName: a.entityName });
    });
    const assignmentTins = new Set(assignmentLookup.map(a => a.tinLast4).filter(Boolean));

    console.log(`%c Expert: ${expertInfo.expert.name} | ${expertInfo.assignments.length} active assignments | Matching: ${assignmentLookup.map(a => a.entityName + ' (***' + a.tinLast4 + ')').join(', ')} | ${expertInfo.expert.totalTranscriptsUploaded} uploaded all-time `, 'background:#1e3a5f;color:white;padding:5px');

    // ---- Get all message links ----
    // Try multiple selectors — IRS SOR uses varying link formats
    let links = document.querySelectorAll('a[href*="read_content"]');
    if (links.length === 0) links = document.querySelectorAll('a[href*="itemId"]');
    if (links.length === 0) links = document.querySelectorAll('a[href*="mailId"]');
    const seen = new Set();
    const messages = [];

    links.forEach(link => {
        // Match itemId or mailId parameter
        const match = link.href.match(/(?:itemId|mailId)=(\d+)/);
        if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            messages.push({ id: match[1], subject: link.textContent.trim() });
        }
    });

    // Fallback: if no links matched, try getting all table row links in the inbox
    if (messages.length === 0) {
        const allLinks = document.querySelectorAll('table a[href], .inbox a[href], #mailList a[href]');
        allLinks.forEach(link => {
            const match = link.href.match(/(\d{5,})/); // Long numeric IDs
            if (match && !seen.has(match[1]) && link.textContent.trim().length > 3) {
                seen.add(match[1]);
                messages.push({ id: match[1], subject: link.textContent.trim() });
            }
        });
    }

    console.log(`%c Found ${messages.length} transcripts in inbox `, 'background:#1e3a5f;color:white;padding:5px;font-weight:bold');
    if (links.length > 0) console.log(`%c Link sample: ${links[0]?.href} `, 'background:#2d3748;color:#90cdf4;padding:3px');

    if (messages.length === 0) {
        // Debug: log what's on the page to help troubleshoot
        const allAnchors = document.querySelectorAll('a');
        console.log(`%c DEBUG: ${allAnchors.length} total links on page `, 'background:#e53e3e;color:white;padding:3px');
        allAnchors.forEach((a, i) => { if (i < 20) console.log(`  Link ${i}: ${a.href} — "${a.textContent.trim().substring(0,50)}"`) });
        alert('No transcripts found in inbox. Check the Console tab for debug info and send a screenshot to your admin.');
        return;
    }

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
        </style>
        <h3>📥 ModernTax Transcript Uploader v6</h3>
        <div class="expert-info">👤 ${expertInfo.expert.name} • ${expertInfo.assignments.length} active assignments • ${expertInfo.expert.totalTranscriptsUploaded} uploaded all-time</div>
        <div style="background:#2d3748;border-radius:5px;padding:8px 12px;margin-bottom:8px;font-size:11px;">
            <div style="color:#a0aec0;margin-bottom:4px;">Active Assignments (matching by TIN):</div>
            ${expertInfo.assignments.map(a => `<div style="color:#68d391;">• ${a.entityName} — ${a.formType} — ${a.uploadedFiles} files uploaded</div>`).join('')}
        </div>
        <div>Processing <strong id="irs-curr">0</strong> / <strong>${messages.length}</strong></div>
        <div class="progress"><div class="progress-bar" id="irs-pbar" style="width:0%">0%</div></div>
        <div class="stats">
            <div class="stat"><div class="stat-num" id="irs-uploaded">0</div><div class="stat-label">Uploaded</div></div>
            <div class="stat"><div class="stat-num" id="irs-matched">0</div><div class="stat-label">Matched</div></div>
            <div class="stat"><div class="stat-num" id="irs-skipped">0</div><div class="stat-label">Skipped</div></div>
            <div class="stat"><div class="stat-num" id="irs-critical">0</div><div class="stat-label">Critical</div></div>
        </div>
        <div class="controls">
            <button class="btn-toggle active" id="irs-local-toggle" onclick="window.irsAlsoLocal=!window.irsAlsoLocal;this.textContent=window.irsAlsoLocal?'💾 +Local ON':'💾 +Local OFF';this.classList.toggle('active')">💾 +Local OFF</button>
            <button class="btn-toggle active" id="irs-report-toggle" onclick="window.irsReport=!window.irsReport;this.textContent=window.irsReport?'📊 Report ON':'📊 Report OFF';this.classList.toggle('active')">📊 Report ON</button>
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
    window.irsReport = true;

    let uploadedCount = 0;
    let matchedCount = 0;
    let skippedCount = 0;
    let criticalCount = 0;

    // ---- Hidden render container ----
    const renderContainer = document.createElement('div');
    renderContainer.id = 'irs-render';
    renderContainer.style.cssText = 'position:fixed; left:-9999px; top:0; width:850px; background:white; z-index:-1;';
    document.body.appendChild(renderContainer);

    // ==========================================================
    // COMPLIANCE SCREENING ENGINE (same as v5)
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

        // Check blank / no record
        if (fullText.match(/No record of return filed/i) || fullText.match(/No transcript available/i)) {
            finding.isBlank = true;
            finding.severity = 'CRITICAL';
            finding.flags.push({ type: 'UNFILED', severity: 'CRITICAL', message: `No record of return filed for ${metadata.taxYear}` });
            return finding;
        }

        // Extract financials
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

        // Transaction codes
        const tcRegex = /(\d{3})\s+(.+?)\s+(\d{2}-\d{2}-\d{4})\s+(\$[\d,.]+|-?\$[\d,.]+)?/g;
        let tcMatch;
        while ((tcMatch = tcRegex.exec(fullText)) !== null) {
            const code = parseInt(tcMatch[1]);
            finding.transactionCodes.push({
                code: tcMatch[1],
                explanation: tcMatch[2].trim(),
                date: tcMatch[3],
                amount: tcMatch[4] || ''
            });

            // Critical codes
            if ([582, 583].includes(code)) {
                finding.flags.push({ type: 'LIEN', severity: 'CRITICAL', message: `Federal tax lien (TC ${code}) filed on ${tcMatch[3]}` });
            }
            if (code === 670 && tcMatch[2]?.match(/levy/i)) {
                finding.flags.push({ type: 'LEVY', severity: 'CRITICAL', message: `Levy action on ${tcMatch[3]}` });
            }
            if ([420, 421].includes(code)) {
                finding.flags.push({ type: 'AUDIT', severity: 'CRITICAL', message: `Examination initiated (TC ${code}) on ${tcMatch[3]}` });
            }
            if (code === 150 && tcMatch[2]?.match(/substitute/i)) {
                finding.flags.push({ type: 'SFR', severity: 'CRITICAL', message: `IRS filed Substitute for Return on ${tcMatch[3]}` });
            }
            if ([520, 530].includes(code)) {
                finding.flags.push({ type: 'COLLECTION', severity: 'CRITICAL', message: `Collection action (TC ${code}) on ${tcMatch[3]}` });
            }

            // Warning codes
            if (code === 971 && tcMatch[2]?.match(/installment/i)) {
                finding.flags.push({ type: 'INSTALLMENT', severity: 'WARNING', message: `Installment agreement on ${tcMatch[3]}` });
            }
            if ([480, 481].includes(code)) {
                finding.flags.push({ type: 'OIC', severity: 'WARNING', message: `Offer in Compromise (TC ${code}) on ${tcMatch[3]}` });
            }
        }

        // Balance due check
        const effectiveBalance = finding.accountBalancePlusAccruals ?? finding.accountBalance;
        if (effectiveBalance !== null && effectiveBalance > 0) {
            finding.flags.push({
                type: 'BALANCE_DUE',
                severity: 'CRITICAL',
                message: `Outstanding balance: $${effectiveBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            });
        }

        // Set severity
        const severities = finding.flags.map(f => f.severity);
        if (severities.includes('CRITICAL')) finding.severity = 'CRITICAL';
        else if (severities.includes('WARNING')) finding.severity = 'WARNING';
        else finding.severity = 'CLEAN';

        return finding;
    }

    // ---- HTML to PDF ----
    async function htmlToPdfBlob(htmlString, filename) {
        renderContainer.innerHTML = htmlString;
        const styleOverride = document.createElement('style');
        styleOverride.textContent = `
            #irs-render { font-family: 'Courier New', monospace; font-size: 11px; color: #000; }
            #irs-render * { max-width: 830px !important; overflow-wrap: break-word; }
            #irs-render table { width: 100% !important; border-collapse: collapse; }
            #irs-render td, #irs-render th { padding: 2px 4px; border: 1px solid #ccc; font-size: 10px; }
        `;
        renderContainer.appendChild(styleOverride);
        await delay(500);

        const canvas = await html2canvas(renderContainer, {
            scale: 2, useCORS: true, logging: false, width: 850, windowWidth: 850, backgroundColor: '#ffffff'
        });

        const imgWidth = 210;
        const pageHeight = 297;
        const margin = 10;
        const contentWidth = imgWidth - (margin * 2);
        const imgHeight = (canvas.height * contentWidth) / canvas.width;

        const pdf = new jsPDF('p', 'mm', 'a4');
        let heightLeft = imgHeight;
        let position = margin;
        const imgData = canvas.toDataURL('image/jpeg', 0.95);

        pdf.addImage(imgData, 'JPEG', margin, position, contentWidth, imgHeight);
        heightLeft -= (pageHeight - margin * 2);

        while (heightLeft > 0) {
            position = -(pageHeight - margin * 2) * (Math.ceil((imgHeight - heightLeft) / (pageHeight - margin * 2))) + margin;
            pdf.addPage();
            pdf.addImage(imgData, 'JPEG', margin, position, contentWidth, imgHeight);
            heightLeft -= (pageHeight - margin * 2);
        }

        pdf.setProperties({ title: filename, creator: 'ModernTax v6' });
        renderContainer.innerHTML = '';
        return pdf.output('blob');
    }

    // ---- Download helper (only used if +Local is on) ----
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

    // Name expansions
    const nameMap = { 'FIL A BAGE': 'Fill A Bagel', 'FILL A BAG': 'Fill A Bagel' };

    // ==========================================================
    // MAIN PROCESSING LOOP
    // ==========================================================

    for (let i = 0; i < messages.length; i++) {
        if (window.irsCancel) { addLog('Cancelled', 'error'); break; }

        const msg = messages[i];
        document.getElementById('irs-curr').textContent = i + 1;
        const pct = Math.round((i + 1) / messages.length * 100);
        document.getElementById('irs-pbar').style.width = pct + '%';
        document.getElementById('irs-pbar').textContent = pct + '%';

        addLog(`[${i+1}/${messages.length}] ${msg.subject.substring(0,50)}...`);

        try {
            // v6 FIX: Initialize session TWICE for first message to avoid stale session bug
            // Try both .jsp and non-.jsp paths (IRS SOR varies)
            const viewUrl = location.href.includes('.jsp')
                ? `/semail/views/view_file.jsp?mailId=${msg.id}&index=0&ext=html&action=view`
                : `/semail/views/view_file?mailId=${msg.id}&index=0&ext=html&action=view`;

            if (i === 0) {
                addLog(`  ⏳ Initializing session (first message — double init)...`, 'warn');
                await fetch(viewUrl, { credentials: 'include' });
                await delay(3000);
                await fetch(viewUrl, { credentials: 'include' });
                await delay(5000);
            } else {
                addLog(`  ⏳ Initializing session...`, 'warn');
                await fetch(viewUrl, { credentials: 'include' });
                await delay(5000);
            }

            // Fetch transcript
            addLog(`  📄 Fetching transcript...`, 'info');
            const transcriptResp = await fetch('/semail/servlet/FileDownload', { credentials: 'include' });
            const transcriptHtml = await transcriptResp.text();

            if (transcriptHtml.includes('transcript-title') || transcriptHtml.includes('item-container') ||
                transcriptHtml.includes('Tax Return Transcript') || transcriptHtml.includes('Account Transcript') ||
                transcriptHtml.includes('Wage and Income') || transcriptHtml.includes('Record of Account') ||
                transcriptHtml.includes('No record of return filed')) {

                const parser = new DOMParser();
                const doc = parser.parseFromString(transcriptHtml, 'text/html');
                const fullText = doc.body?.textContent || '';
                const titleText = doc.querySelector('title')?.textContent || '';

                // Get transcript type
                const titleEl = doc.querySelector('h1.transcript-title') || doc.querySelector('h2') || doc.querySelector('h3 b');
                let transcriptType = titleEl?.textContent?.trim() || titleText || 'Transcript';
                let shortType = 'Transcript';
                if (transcriptType.match(/Return Transcript/i)) shortType = 'Return Transcript';
                else if (transcriptType.match(/Account Transcript/i)) shortType = 'Account Transcript';
                else if (transcriptType.match(/Record of Account/i)) shortType = 'Record of Account';
                else if (transcriptType.match(/Wage and Income/i)) shortType = 'Wage and Income';

                // Get form, TIN, year, name
                let formType = '', tin = '', taxYear = '', taxpayerName = '';

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

                // Old format fallback
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

                const name = nameMap[taxpayerName] || taxpayerName || 'Unknown';
                const cleanName = name.substring(0, 20).replace(/[^a-zA-Z0-9 &]/g, '').trim().replace(/\s+/g, ' ');
                const baseFilename = `${cleanName} - ${formType} ${shortType} - ${taxYear}`;

                const metadata = { name, tin, formType, taxYear, shortType };

                // ---- COMPLIANCE SCREENING ----
                addLog(`  🔍 Screening for compliance...`, 'warn');
                const finding = screenTranscript(transcriptHtml, metadata);
                allFindings.push(finding);

                if (finding.severity === 'CRITICAL') {
                    criticalCount++;
                    document.getElementById('irs-critical').textContent = criticalCount;
                    finding.flags.filter(f => f.severity === 'CRITICAL').forEach(f => addLog(`  🔴 ${f.message}`, 'error'));
                } else if (finding.severity === 'WARNING') {
                    finding.flags.filter(f => f.severity === 'WARNING').forEach(f => addLog(`  🟡 ${f.message}`, 'warn'));
                } else {
                    addLog(`  ✅ Clean`, 'success');
                }

                // ---- PRE-CHECK: Does this transcript match any assignment? ----
                // IRS masks TINs — match by last 4 digits + first 3 letters of name
                const cleanTin = (tin || '').replace(/[\s-]/g, '');
                const tinLast4 = cleanTin.slice(-4);
                const transcriptNamePrefix = (name || '').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();

                const isMatch = assignmentLookup.some(a => {
                    // Match by TIN last 4 (primary)
                    if (tinLast4 && a.tinLast4 && tinLast4 === a.tinLast4) return true;
                    // Match by name prefix (fallback when TIN is fully masked)
                    if (transcriptNamePrefix && a.namePrefix && transcriptNamePrefix === a.namePrefix) return true;
                    return false;
                });

                if (!isMatch) {
                    addLog(`  ⏭️ Skipped — ${name.substring(0,20)} (***${tinLast4 || '????'}) not in your assignments`, 'warn');
                    results.push({ success: false, skipped: true, reason: 'not assigned', name, tin });
                    await delay(500);
                    continue;
                }

                // ---- CONVERT TO PDF ----
                addLog(`  🔄 Converting to PDF...`, 'warn');
                const pdfBlob = await htmlToPdfBlob(transcriptHtml, baseFilename + '.pdf');

                // ---- UPLOAD TO PORTAL ----
                addLog(`  📤 Uploading to portal...`, 'upload');

                const formData = new FormData();
                formData.append('file', pdfBlob, baseFilename + '.pdf');
                formData.append('metadata', JSON.stringify({
                    tin,
                    formType,
                    taxYear,
                    shortType,
                    taxpayerName: name,
                    filename: baseFilename + '.pdf',
                    compliance: finding,
                }));

                try {
                    const uploadResp = await fetch(`${PORTAL_URL}/api/expert/batch-upload`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
                        body: formData,
                    });

                    const uploadResult = await uploadResp.json();

                    if (uploadResp.ok) {
                        uploadedCount++;
                        matchedCount++;
                        document.getElementById('irs-uploaded').textContent = uploadedCount;
                        document.getElementById('irs-matched').textContent = matchedCount;
                        addLog(`  ✅ → ${uploadResult.entityName} (${uploadResult.totalFiles} files)`, 'success');
                    } else {
                        unmatchedCount++;
                        document.getElementById('irs-unmatched').textContent = unmatchedCount;
                        addLog(`  ⚠️ Portal: ${uploadResult.error}`, 'warn');

                        // Save locally as fallback if unmatched
                        downloadBlob(pdfBlob, baseFilename + '.pdf');
                        addLog(`  💾 Saved locally: ${baseFilename}.pdf`, 'info');
                    }
                } catch (uploadErr) {
                    skippedCount++;
                    document.getElementById('irs-skipped').textContent = skippedCount;
                    addLog(`  ❌ Upload failed: ${uploadErr.message}`, 'error');
                    downloadBlob(pdfBlob, baseFilename + '.pdf');
                    addLog(`  💾 Saved locally as fallback`, 'info');
                }

                // Also save locally if toggle is on
                if (window.irsAlsoLocal) {
                    downloadBlob(pdfBlob, baseFilename + '.pdf');
                }

                results.push({ success: true, filename: baseFilename, name, tin, formType, taxYear, finding });

            } else {
                addLog(`  ❌ Did not get transcript content`, 'error');
                results.push({ success: false, error: 'No transcript content' });
            }

        } catch (err) {
            addLog(`  ❌ ${err.message}`, 'error');
            results.push({ success: false, error: err.message });
        }

        await delay(1500);
    }

    // ---- Cleanup ----
    renderContainer.remove();

    // ---- Final Summary ----
    const ok = results.filter(r => r.success).length;
    const warnings = allFindings.filter(f => f.severity === 'WARNING').length;

    addLog(`\n${'='.repeat(50)}`, 'info');
    addLog(`✅ Processed ${ok}/${messages.length} transcripts`, ok > 0 ? 'success' : 'error');
    const skippedTotal = results.filter(r => r.skipped).length;
    addLog(`📤 Uploaded: ${uploadedCount} | Matched: ${matchedCount} | Skipped (not yours): ${skippedTotal + skippedCount}`, 'upload');
    addLog(`📊 Compliance: ${criticalCount} critical, ${warnings} warnings, ${allFindings.length - criticalCount - warnings} clean`,
        criticalCount > 0 ? 'error' : warnings > 0 ? 'warn' : 'success');

    if (ok > 0) {
        const byName = {};
        results.filter(r => r.success).forEach(r => {
            if (!byName[r.name]) byName[r.name] = [];
            byName[r.name].push(r);
        });
        Object.keys(byName).forEach(n => {
            addLog(`\n📁 ${n} (TIN: ${byName[n][0].tin})`, 'info');
            byName[n].forEach(r => addLog(`   • ${r.formType} ${r.taxYear} ${r.finding?.severity === 'CRITICAL' ? '🔴' : r.finding?.severity === 'WARNING' ? '🟡' : '✅'}`, 'success'));
        });
    }

    const skippedFinal = results.filter(r => r.skipped).length;
    alert(`Done! ${uploadedCount} transcripts uploaded to portal.\n${skippedFinal > 0 ? skippedFinal + ' skipped (not in your assignments).\n' : ''}\nCompliance: ${criticalCount} critical, ${warnings} warnings.`);
    return { results, findings: allFindings, uploaded: uploadedCount, unmatched: unmatchedCount };
})();
