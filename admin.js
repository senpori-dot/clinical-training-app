const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const appEl = document.getElementById("app");
const CATEGORY_LABEL = { internal_medicine: "内科系", surgery: "外科系" };
const INSTITUTION_LABEL = { internal: "院内", external: "院外" };

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

async function checkAuth() {
  if (sessionStorage.getItem("admin_ok") === "1") {
    renderDashboard();
    return;
  }
  appEl.innerHTML = `
    <div class="card">
      <b>管理者パスワード</b>
      <div style="margin:10px 0;"><input type="password" id="pw" placeholder="パスワード" /></div>
      <button id="login-btn">ログイン</button>
      <div class="notice warn" id="pw-error" style="display:none; margin-top:10px;"></div>
    </div>`;
  document.getElementById("login-btn").onclick = async () => {
    const pw = document.getElementById("pw").value;
    const { data, error } = await sb.rpc("verify_admin_password", { input_password: pw });
    if (error || !data) {
      document.getElementById("pw-error").style.display = "block";
      document.getElementById("pw-error").textContent = "パスワードが違います。";
      return;
    }
    sessionStorage.setItem("admin_ok", "1");
    renderDashboard();
  };
}

let activeTab = "students";

async function renderDashboard() {
  appEl.innerHTML = `
    <div class="admin-tabs">
      <button data-tab="students" class="${activeTab==='students'?'active':''}">学生・リンク</button>
      <button data-tab="rounds" class="${activeTab==='rounds'?'active':''}">ラウンド管理</button>
      <button data-tab="matching" class="${activeTab==='matching'?'active':''}">集計・抽選</button>
    </div>
    <div id="tab-content"><p>読み込み中...</p></div>
  `;
  document.querySelectorAll(".admin-tabs button").forEach(b => {
    b.onclick = () => { activeTab = b.dataset.tab; renderDashboard(); };
  });
  if (activeTab === "students") renderStudentsTab();
  else if (activeTab === "rounds") renderRoundsTab();
  else renderMatchingTab();
}

async function renderStudentsTab() {
  const { data: students } = await sb.from("students").select("*").order("attendance_number");
  const baseUrl = location.origin + location.pathname.replace(/admin\.html$/, "index.html");

  let rows = students.map(s => {
    const link = `${baseUrl}?token=${s.access_token}`;
    return `<tr>
      <td>${s.attendance_number}</td>
      <td>${esc(s.name)}</td>
      <td><input type="text" readonly value="${link}" style="font-size:0.75rem;" onclick="this.select()"/></td>
      <td><button class="small secondary copy-btn" data-link="${link}">コピー</button></td>
    </tr>`;
  }).join("");

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <div class="flex-between">
        <b>学生一覧（全${students.length}名）</b>
        <button class="small" id="export-csv">CSVで一覧出力</button>
      </div>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>番号</th><th>氏名</th><th>専用URL</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.querySelectorAll(".copy-btn").forEach(b => {
    b.onclick = () => { navigator.clipboard.writeText(b.dataset.link); b.textContent = "コピー済"; setTimeout(()=>b.textContent="コピー",1200); };
  });

  document.getElementById("export-csv").onclick = () => {
    const csv = "出席番号,氏名,専用URL\n" + students.map(s => `${s.attendance_number},${s.name},${baseUrl}?token=${s.access_token}`).join("\n");
    const blob = new Blob(["\uFEFF"+csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "student_links.csv";
    a.click();
  };
}

// ============================================================
// ラウンド管理（タームを1つ指定して、全員でそのタームを決めるラウンド）
// ============================================================
async function renderRoundsTab() {
  const { data: rounds } = await sb.from("rounds").select("*").order("round_number");

  let rows = (rounds || []).map(r => `
    <tr>
      <td>第${r.round_number}希望</td>
      <td>${r.phase}</td>
      <td class="small-muted">
        開始:${r.start_at ? new Date(r.start_at).toLocaleString("ja-JP") : "-"}<br/>
        1次締切:${r.end_at ? new Date(r.end_at).toLocaleString("ja-JP") : "-"}<br/>
        2次締切:${r.second_deadline ? new Date(r.second_deadline).toLocaleString("ja-JP") : "-"}
      </td>
      <td>${r.is_current ? "★現在" : ""}</td>
      <td>${!r.is_current ? `<button class="small set-current" data-id="${r.id}">現在にする</button>` : ""}</td>
    </tr>`).join("");

  const nextRoundNumber = rounds && rounds.length ? Math.max(...rounds.map(r=>r.round_number)) + 1 : 1;

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <b>ラウンド一覧</b>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>ラウンド</th><th>状態</th><th>日程</th><th></th><th></th></tr></thead>
        <tbody>${rows || ""}</tbody>
      </table>
    </div>
    <div class="card">
      <b>新しいラウンドを作成（第${nextRoundNumber}希望）</b>
      <p class="small-muted">学生は①〜⑥のうち、まだ決まっていないクールから自由に実習先を選んで希望を出せます。</p>
      <div style="margin:10px 0;">
        <label class="small-muted">開始日時</label>
        <input type="datetime-local" id="new-start" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">1次締切日時（この日時を過ぎると自動で抽選されます）</label>
        <input type="datetime-local" id="new-end" />
      </div>
      <div style="margin:10px 0;">
        <label class="small-muted">2次マッチング締切日時（1次抽選で外れた人の再提出締切。この日時を過ぎると自動で2次抽選されます）</label>
        <input type="datetime-local" id="new-second-deadline" />
      </div>
      <div style="margin:10px 0;">
        <p class="small-muted">氏名の公開ルール: 宿泊が絡まない施設は抽選確定まで自動的に匿名、宿泊が絡む施設は本人が任意のタイミングで公開できます（このラウンド作成では設定不要です）。</p>
      </div>
      <button id="create-round">作成して現在ラウンドにする</button>
    </div>
  `;

  document.querySelectorAll(".set-current").forEach(b => {
    b.onclick = async () => {
      await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
      await sb.from("rounds").update({ is_current: true }).eq("id", b.dataset.id);
      renderRoundsTab();
    };
  });

  document.getElementById("create-round").onclick = async () => {
    const startVal = document.getElementById("new-start").value;
    const endVal = document.getElementById("new-end").value;
    const secondDeadlineVal = document.getElementById("new-second-deadline").value;
    await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
    await sb.from("rounds").insert({
      round_number: nextRoundNumber,
      course_number: null,
      start_at: startVal ? new Date(startVal).toISOString() : null,
      end_at: endVal ? new Date(endVal).toISOString() : null,
      second_deadline: secondDeadlineVal ? new Date(secondDeadlineVal).toISOString() : null,
      is_current: true,
      phase: "first_choice",
    });
    renderRoundsTab();
  };
}

// ============================================================
// 集計・抽選（ラウンドのタームは固定なので、枠ごとの集計のみ）
// ============================================================
async function renderMatchingTab() {
  const { data: round0 } = await sb.from("rounds").select("*").eq("is_current", true).maybeSingle();
  if (!round0) {
    document.getElementById("tab-content").innerHTML = `<div class="notice info">現在のラウンドが設定されていません。「ラウンド管理」タブでラウンドを作成してください。</div>`;
    return;
  }

  const round = await window.tryRunLotteryIfDue(sb, round0);

  if (round.phase.endsWith("_processing")) {
    document.getElementById("tab-content").innerHTML = `<div class="notice info">現在、自動抽選を処理中です。数秒後に再読み込みしてください。</div>`;
    return;
  }

  const attempt = round.phase === "second_match" ? 2 : 1;
  const now = new Date();
  const relevantDeadline = attempt === 2 ? round.second_deadline : round.end_at;
  const deadlinePassed = relevantDeadline && now > new Date(relevantDeadline);

  const { data: prefs } = await sb
    .from("preferences")
    .select("*, students(attendance_number, name), slots(facility_name, department_name, cap_1,cap_2,cap_3,cap_4,cap_5,cap_6)")
    .eq("round_id", round.id)
    .eq("attempt", attempt);

  const groups = {};
  for (const p of (prefs || [])) {
    const key = p.slot_id + "_" + p.course_number;
    if (!groups[key]) {
      groups[key] = { slot: p.slots, courseNumber: p.course_number, cap: p.slots["cap_"+p.course_number], items: [] };
    }
    groups[key].items.push(p);
  }

  const groupList = Object.values(groups).sort((a,b)=>a.courseNumber-b.courseNumber);

  // ===== 全体表（①〜⑥クール × 全実習先、匿名関係なく全員の名前が見える） =====
  const { data: allSlots } = await sb.from("slots").select("*").eq("active", true);
  const { data: allAssignments } = await sb
    .from("assignments")
    .select("slot_id, course_number, students(attendance_number, name)");

  function buildGrid(institutionType, label) {
    const list = (allSlots || [])
      .filter(s => s.institution_type === institutionType)
      .sort((a,b) => a.sort_order - b.sort_order);
    if (list.length === 0) return "";

    let rows = "";
    let prevFacility = null;
    for (const s of list) {
      const facilityChanged = institutionType === "external" && s.facility_name !== prevFacility;
      prevFacility = s.facility_name;
      const rowClass = s.category === "internal_medicine" ? "row-naika" : "row-geka";
      rows += `<tr class="${rowClass} ${facilityChanged ? 'facility-start' : ''}"><td class="dept-col"><b>${esc(s.facility_name)}</b><br/>${esc(s.department_name)}</td>`;
      for (let c = 1; c <= 6; c++) {
        const cap = s["cap_" + c];
        if (cap <= 0) { rows += `<td class="cell-slot cell-blocked">×</td>`; continue; }
        const confirmedHere = (allAssignments || []).filter(a => a.slot_id === s.id && a.course_number === c);
        const pendingHere = (prefs || []).filter(p => p.slot_id === s.id && p.course_number === c && p.status !== "confirmed");
        const total = confirmedHere.length + pendingHere.length;
        const names = [
          ...confirmedHere.map(a => `<b>${a.students.attendance_number} ${esc(a.students.name)}</b>`),
          ...pendingHere.map(p => `${p.students.attendance_number} ${esc(p.students.name)}(${p.status})`),
        ].join("<br>");
        const overflowClass = total > cap ? "frame-over" : (total === cap ? "frame-exact" : "");
        rows += `<td class="cell-slot ${overflowClass}"><div class="cell-cap">${total}/${cap}</div>${names ? `<div class="cell-names">${names}</div>` : ""}</td>`;
      }
      rows += `</tr>`;
    }
    const header = `<tr><th class="dept-col">実習先/診療科</th>${window.COURSE_LABELS.map((l,i)=>`<th>${l}<br/><span class="course-date">${window.COURSE_DATES[i]}</span></th>`).join("")}</tr>`;
    return `<div class="card">
      <b>${label}の全体表（管理者用・氏名は常に表示）</b>
      <div class="grid-scroll" style="margin-top:8px;">
        <table class="pref-grid"><thead>${header}</thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;
  }

  const gridHtml = buildGrid("internal", "院内") + buildGrid("external", "院外");

  let rows = groupList.map(g => {
    const overflow = g.items.length > g.cap;
    const names = g.items.map(i => `${i.students.attendance_number} ${esc(i.students.name)}${i.status!=='submitted' ? `(${i.status})` : ''}`).join("、 ");
    return `<tr class="${overflow?'overflow':''}">
      <td>${window.COURSE_LABELS[g.courseNumber-1]}</td>
      <td>${esc(g.slot.facility_name)} ${esc(g.slot.department_name)}</td>
      <td class="cap">${g.items.length} / ${g.cap}</td>
      <td class="small-muted">${names}</td>
    </tr>`;
  }).join("");

  document.getElementById("tab-content").innerHTML = `
    ${gridHtml}
    <div class="card">
      <div class="flex-between">
        <b>第${round.round_number}希望（${attempt===2?'2次マッチング':'1次'}）の集計</b>
        <span class="small-muted">状態: ${round.phase}</span>
      </div>
      <p class="small-muted">${relevantDeadline ? `締切: ${new Date(relevantDeadline).toLocaleString("ja-JP")}${deadlinePassed ? '（締切超過 — 通常は自動で抽選されます）' : '（締切前は自由に希望を出せます。定員オーバーもOK）'}` : "締切未設定"}</p>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>クール</th><th>実習先</th><th>希望者数/定員</th><th>希望者</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small-muted">まだ希望の提出がありません</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <b>抽選・確定処理</b>
      <p class="small-muted">通常は締切を過ぎると自動で実行されます（誰かがページを開いたタイミングで処理されます）。締切前でも今すぐ確定したい場合はこちらのボタンで手動実行できます。</p>
      <button id="run-lottery">今すぐ抽選を実行する</button>
      <div id="lottery-result" class="small-muted" style="margin-top:8px;"></div>
    </div>
  `;

  document.getElementById("run-lottery").onclick = async () => {
    const btn = document.getElementById("run-lottery");
    btn.disabled = true;
    btn.textContent = "処理中...";
    const result = await window.runLotteryCore(sb, round, round.phase === "second_match" ? "second_match" : "first_choice");
    document.getElementById("lottery-result").textContent = `完了：確定 ${result.confirmedCount}件 / 抽選漏れ ${result.lostCount}件`;
    btn.textContent = "今すぐ抽選を実行する";
    btn.disabled = false;
    renderMatchingTab();
  };
}

checkAuth();
