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

// ============================================================
// 学生・リンク管理
// ============================================================
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
// ラウンド管理
// ============================================================
async function renderRoundsTab() {
  const { data: rounds } = await sb.from("rounds").select("*").order("round_number");

  let rows = (rounds || []).map(r => `
    <tr>
      <td>第${r.round_number}希望</td>
      <td>${r.phase}</td>
      <td>${r.deadline ? new Date(r.deadline).toLocaleString("ja-JP") : "-"}</td>
      <td>${r.is_current ? "★現在" : ""}</td>
      <td>${!r.is_current ? `<button class="small set-current" data-id="${r.id}">現在ラウンドにする</button>` : ""}</td>
    </tr>`).join("");

  const nextRoundNumber = rounds && rounds.length ? Math.max(...rounds.map(r=>r.round_number)) + 1 : 1;

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <b>ラウンド一覧</b>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>ラウンド</th><th>状態</th><th>締切</th><th></th><th></th></tr></thead>
        <tbody>${rows || ""}</tbody>
      </table>
    </div>
    <div class="card">
      <b>新しいラウンドを作成（第${nextRoundNumber}希望）</b>
      <div style="margin:10px 0;">
        <label class="small-muted">締切日時（任意）</label>
        <input type="datetime-local" id="new-deadline" />
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
    const deadlineVal = document.getElementById("new-deadline").value;
    await sb.from("rounds").update({ is_current: false }).neq("id", "00000000-0000-0000-0000-000000000000");
    await sb.from("rounds").insert({
      round_number: nextRoundNumber,
      deadline: deadlineVal ? new Date(deadlineVal).toISOString() : null,
      is_current: true,
      phase: "first_choice",
    });
    renderRoundsTab();
  };
}

// ============================================================
// 集計・抽選
// ============================================================
async function renderMatchingTab() {
  const { data: round } = await sb.from("rounds").select("*").eq("is_current", true).maybeSingle();
  if (!round) {
    document.getElementById("tab-content").innerHTML = `<div class="notice info">現在のラウンドが設定されていません。「ラウンド管理」タブでラウンドを作成してください。</div>`;
    return;
  }

  const attempt = round.phase === "second_match" ? 2 : 1;

  const { data: prefs } = await sb
    .from("preferences")
    .select("*, students(attendance_number, name), slots(facility_name, department_name, cap_1,cap_2,cap_3,cap_4,cap_5,cap_6)")
    .eq("round_id", round.id)
    .eq("attempt", attempt);

  const groups = {};
  for (const p of (prefs || [])) {
    const key = `${p.slot_id}_${p.course_number}`;
    if (!groups[key]) {
      groups[key] = { slot: p.slots, course_number: p.course_number, cap: p.slots["cap_"+p.course_number], items: [] };
    }
    groups[key].items.push(p);
  }

  const groupList = Object.values(groups).sort((a,b)=>a.course_number-b.course_number);

  let rows = groupList.map(g => {
    const overflow = g.items.length > g.cap;
    const names = g.items.map(i => `${i.students.attendance_number} ${esc(i.students.name)}${i.status!=='submitted' ? `(${i.status})` : ''}`).join("、 ");
    return `<tr class="${overflow?'overflow':''}">
      <td>${window.COURSE_LABELS[g.course_number-1]}</td>
      <td>${esc(g.slot.facility_name)} ${esc(g.slot.department_name)}</td>
      <td class="cap">${g.items.length} / ${g.cap}</td>
      <td class="small-muted">${names}</td>
    </tr>`;
  }).join("");

  document.getElementById("tab-content").innerHTML = `
    <div class="card">
      <div class="flex-between">
        <b>第${round.round_number}希望ラウンド（${attempt===2?'2次マッチング':'1次'}）の集計</b>
        <span class="small-muted">状態: ${round.phase}</span>
      </div>
      <table class="slots" style="margin-top:10px;">
        <thead><tr><th>クール</th><th>実習先</th><th>希望者数/定員</th><th>希望者</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small-muted">まだ希望の提出がありません</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <b>抽選・確定処理</b>
      <p class="small-muted">定員を超えている枠についてランダムに当選者を決め、超過者は「lost」として記録します（2次マッチング対象になります）。定員内の枠は全員確定扱いになります。</p>
      <button id="run-lottery">抽選を実行して確定する</button>
      <div id="lottery-result" class="small-muted" style="margin-top:8px;"></div>
    </div>
  `;

  document.getElementById("run-lottery").onclick = async () => {
    const btn = document.getElementById("run-lottery");
    btn.disabled = true;
    btn.textContent = "処理中...";
    let confirmedCount = 0, lostCount = 0;

    for (const g of groupList) {
      const shuffled = g.items.slice().sort(() => Math.random() - 0.5);
      const winners = shuffled.slice(0, g.cap);
      const losers = shuffled.slice(g.cap);

      for (const w of winners) {
        await sb.from("preferences").update({ status: "confirmed" }).eq("id", w.id);
        await sb.from("assignments").upsert({
          student_id: w.student_id,
          course_number: w.course_number,
          slot_id: w.slot_id,
        }, { onConflict: "student_id,course_number" });
        confirmedCount++;
      }
      for (const l of losers) {
        await sb.from("preferences").update({ status: "lost" }).eq("id", l.id);
        lostCount++;
      }
    }

    document.getElementById("lottery-result").textContent = `完了：確定 ${confirmedCount}件 / 抽選漏れ ${lostCount}件`;
    btn.textContent = "抽選を実行して確定する";
    btn.disabled = false;

    if (lostCount > 0 && round.phase !== "second_match") {
      await sb.from("rounds").update({ phase: "second_match" }).eq("id", round.id);
    } else if (lostCount === 0) {
      await sb.from("rounds").update({ phase: "closed" }).eq("id", round.id);
    }
    renderMatchingTab();
  };
}

checkAuth();
