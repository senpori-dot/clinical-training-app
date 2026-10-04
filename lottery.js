// ============================================================
// 抽選の共通ロジック（学生ページ・管理画面の両方から呼び出す）
// ============================================================
// ラウンドは「第◯希望」というランク。学生は①〜⑥のうちまだ決まっていない
// クールの中から自由に(実習先, クール)の組を選んで希望を出す。
// 締切を過ぎたら、(実習先, クール)ごとに集計して定員超過分を抽選する。
// 抽選は完全ランダム（優先ルールなし）。
window.tryRunLotteryIfDue = async function (sb, round) {
  if (!round) return round;
  const now = new Date();

  // 「処理中」のまま5分以上止まっている場合（抽選中にページが閉じられた等）は、元の状態に戻して再開する
  if (round.phase && round.phase.endsWith("_processing")) {
    const startedAt = round.processing_at ? new Date(round.processing_at).getTime() : 0;
    if (!startedAt || now.getTime() - startedAt > 5 * 60 * 1000) {
      const basePhase = round.phase.replace("_processing", "");
      const { data: reset } = await sb.from("rounds")
        .update({ phase: basePhase })
        .eq("id", round.id).eq("phase", round.phase)
        .select();
      if (reset && reset.length > 0) round = reset[0];
      else return round;
    } else {
      return round;
    }
  }

  let phaseToProcess = null;
  if (round.phase === "first_choice" && round.end_at && now > new Date(round.end_at)) {
    phaseToProcess = "first_choice";
  } else if (round.phase === "second_match" && round.second_deadline && now > new Date(round.second_deadline)) {
    phaseToProcess = "second_match";
  } else if (round.phase === "third_match" && round.third_deadline && now > new Date(round.third_deadline)) {
    phaseToProcess = "third_match";
  }
  if (!phaseToProcess) return round;

  const lockPhase = phaseToProcess + "_processing";
  const { data: locked } = await sb
    .from("rounds")
    .update({ phase: lockPhase, processing_at: new Date().toISOString() })
    .eq("id", round.id)
    .eq("phase", phaseToProcess)
    .select();

  if (!locked || locked.length === 0) {
    const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
    return fresh || round;
  }

  try {
    await window.runLotteryCore(sb, round, phaseToProcess);
  } catch (err) {
    // 途中で失敗した場合、processing状態のまま固まらないよう自動的に元のphaseへ戻す。
    // これにより、次に誰かがページを開いたときに自動で再試行される。
    console.error("抽選処理中にエラーが発生しました。ロックを解除して再試行できるようにします。", err);
    await sb.from("rounds").update({ phase: phaseToProcess }).eq("id", round.id).eq("phase", lockPhase);
    const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
    return fresh || round;
  }

  const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
  return fresh || round;
};

// 枠の種類（院内内科 IN_N / 院内外科 IN_G / 院外内科 EX_N / 院外外科 EX_G）
function lotteryComboKey(slot) {
  return (slot.institution_type === "internal" ? "IN" : "EX") + "_" + (slot.category === "internal_medicine" ? "N" : "G");
}

// 偏りのないシャッフル（Fisher–Yates）
function lotteryShuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 実際の抽選処理本体：(実習先, クール)ごと、かつ施設全体の人数上限も考慮したグローバル抽選
// ※ 他のラウンドで既に確定している人数もベースとして考慮し、定員を絶対に超えないようにする
window.runLotteryCore = async function (sb, round, phaseToProcess) {
  const attempt = phaseToProcess === "third_match" ? 3 : phaseToProcess === "second_match" ? 2 : 1;

  const { data: prefs, error: prefsErr } = await sb
    .from("preferences")
    .select("id, student_id, slot_id, course_number, paired_course_number, status")
    .eq("round_id", round.id)
    .eq("attempt", attempt)
    .eq("status", "submitted");
  if (prefsErr) console.error("preferences fetch error", prefsErr);

  const { data: facilityLimits } = await sb.from("facility_limits").select("*");
  const limitMap = {};
  (facilityLimits || []).forEach(f => { limitMap[f.facility_name] = f.max_total; });

  // slots情報はembed(join)を使わず、一度全件取得して自前でマップ化する
  // （環境によってはembed joinが失敗し、定員チェックが機能しなくなることがあったため）
  const { data: allSlots, error: slotsErr } = await sb
    .from("slots")
    .select("id, facility_name, department_name, institution_type, category, active, new_courses, cap_1, cap_2, cap_3, cap_4, cap_5, cap_6");
  if (slotsErr) console.error("slots fetch error", slotsErr);
  const slotMap = {};
  (allSlots || []).forEach(s => { slotMap[s.id] = s; });

  // 既に確定済み（他のラウンドを含む全体）の人数をベースラインとして読み込む
  const { data: existingAssignments, error: existingErr } = await sb
    .from("assignments")
    .select("student_id, slot_id, course_number, count_exempt");
  if (existingErr) console.error("assignments fetch error", existingErr);

  const slotCourseCount = {};
  const facilityCourseCount = {};
  for (const a of (existingAssignments || [])) {
    const slotKey = a.slot_id + "_" + a.course_number;
    slotCourseCount[slotKey] = (slotCourseCount[slotKey] || 0) + 1;
    const s = slotMap[a.slot_id];
    const fname = s && s.facility_name;
    if (fname) {
      const facKey = fname + "_" + a.course_number;
      facilityCourseCount[facKey] = (facilityCourseCount[facKey] || 0) + 1;
    }
  }

  // 完全ランダムな順番で処理する（優先ルールなし）
  const ordered = lotteryShuffle(prefs || []);

  let confirmedCount = 0, lostCount = 0;

  // 各(枠,クール)ごとの今回の希望者数を先に数えておく（抽選が発生したかどうかの判定に使う）
  const groupTotal = {};
  for (const p of ordered) {
    const key = p.slot_id + "_" + p.course_number;
    groupTotal[key] = (groupTotal[key] || 0) + 1;
  }

  for (const p of ordered) {
    const slot = slotMap[p.slot_id];
    if (!slot) { // 万一slot情報が取れなければ安全側に倒してlostにする
      await sb.from("preferences").update({ status: "lost" }).eq("id", p.id);
      lostCount++;
      continue;
    }
    const cap = slot["cap_" + p.course_number];
    const fname = slot.facility_name;
    const slotKey = p.slot_id + "_" + p.course_number;
    const facKey = fname + "_" + p.course_number;
    const curSlot = slotCourseCount[slotKey] || 0;
    const curFac = facilityCourseCount[facKey] || 0;
    const facLimit = limitMap[fname];
    const wasCompetitive = (groupTotal[slotKey] + curSlot) > cap;

    // 病理診断など「2クール連続で履修が必要」な希望は、両方のクールに空きがある場合のみまとめて確定する
    if (p.paired_course_number) {
      const pairCourse = p.paired_course_number;
      const pairCap = slot["cap_" + pairCourse];
      const pairSlotKey = p.slot_id + "_" + pairCourse;
      const pairFacKey = fname + "_" + pairCourse;
      const curPairSlot = slotCourseCount[pairSlotKey] || 0;
      const curPairFac = facilityCourseCount[pairFacKey] || 0;
      const pairOk = curPairSlot < pairCap && (!facLimit || curPairFac < facLimit);
      const primaryOk = curSlot < cap && (!facLimit || curFac < facLimit);

      if (primaryOk && pairOk) {
        await sb.from("preferences").update({ status: "confirmed", won_lottery: wasCompetitive }).eq("id", p.id);
        await sb.from("assignments").upsert(
          { student_id: p.student_id, course_number: p.course_number, slot_id: p.slot_id },
          { onConflict: "student_id,course_number" }
        );
        await sb.from("assignments").upsert(
          { student_id: p.student_id, course_number: pairCourse, slot_id: p.slot_id },
          { onConflict: "student_id,course_number" }
        );
        slotCourseCount[slotKey] = curSlot + 1;
        facilityCourseCount[facKey] = curFac + 1;
        slotCourseCount[pairSlotKey] = curPairSlot + 1;
        facilityCourseCount[pairFacKey] = curPairFac + 1;
        confirmedCount++;
      } else {
        // 片方でも埋まっていれば、2クール連続が成立しないためどちらも不成立にする
        await sb.from("preferences").update({ status: "lost", won_lottery: false }).eq("id", p.id);
        lostCount++;
      }
      continue;
    }

    if (curSlot < cap && (!facLimit || curFac < facLimit)) {
      await sb.from("preferences").update({ status: "confirmed", won_lottery: wasCompetitive }).eq("id", p.id);
      await sb.from("assignments").upsert(
        { student_id: p.student_id, course_number: p.course_number, slot_id: p.slot_id },
        { onConflict: "student_id,course_number" }
      );
      slotCourseCount[slotKey] = curSlot + 1;
      facilityCourseCount[facKey] = curFac + 1;
      confirmedCount++;
    } else {
      await sb.from("preferences").update({ status: "lost", won_lottery: false }).eq("id", p.id);
      lostCount++;
    }
  }

  // 外れた人がいたかは、今回処理した分だけでなく、この回の全員分をDBから数え直して判定する
  // （抽選が途中で止まって再開した場合でも、前半で外れた人を見落とさないため）
  let totalLost = lostCount;
  if (phaseToProcess === "first_choice") {
    const { count } = await sb.from("preferences")
      .select("id", { count: "exact", head: true })
      .eq("round_id", round.id).eq("attempt", 1).eq("status", "lost");
    if (typeof count === "number") totalLost = Math.max(totalLost, count);
  }
  const nextPhase = phaseToProcess === "first_choice"
    ? (totalLost > 0 ? "second_match" : "closed")
    : "closed";

  await sb.from("rounds").update({ phase: nextPhase }).eq("id", round.id);

  return { confirmedCount, lostCount, nextPhase };
};

// ============================================================
// 空き枠トレード（自分の確定枠 → 同じクール・同じ種類の空き枠へ移動）
// ・締切までに申請を集め、締切後に移動先ごとに抽選する
// ・当たれば移動、外れれば元の枠のまま
// ・処理後に「空いた枠」を記録し、学生画面でアナウンスする
// ・move_runs（回）ごとに開始・締切を設定できる（何回でも）
// ============================================================
function moveComboKey(s) {
  return (s.institution_type === "internal" ? "IN" : "EX") + "_" + (s.category === "internal_medicine" ? "N" : "G");
}

window.tryRunMoveIfDue = async function (sb) {
  try {
    const { data: runs } = await sb.from("move_runs").select("*").order("run_number");
    if (!runs) return;
    const now = Date.now();
    for (const run of runs) {
      // 処理中のまま5分以上止まっていたら再開できるように戻す
      if (run.status === "processing") {
        const st = run.processing_at ? new Date(run.processing_at).getTime() : 0;
        if (!st || now - st > 5 * 60 * 1000) {
          await sb.from("move_runs").update({ status: "open" }).eq("id", run.id).eq("status", "processing");
          run.status = "open";
        } else continue;
      }
      if (run.status !== "open" || !run.deadline || now <= new Date(run.deadline).getTime()) continue;
      const { data: locked } = await sb.from("move_runs")
        .update({ status: "processing", processing_at: new Date().toISOString() })
        .eq("id", run.id).eq("status", "open").select();
      if (!locked || locked.length === 0) continue;
      try {
        await window.runMoveCore(sb, run);
      } catch (e) {
        console.error("空き枠トレードの処理でエラー。再試行できるように戻します", e);
        await sb.from("move_runs").update({ status: "open" }).eq("id", run.id).eq("status", "processing");
      }
    }
  } catch (e) { console.error(e); }
};

window.runMoveCore = async function (sb, run) {
  const { data: reqs } = await sb.from("move_requests").select("*").eq("run_id", run.id).eq("status", "pending");
  const { data: slots } = await sb.from("slots").select("id, facility_name, department_name, institution_type, category, cap_1, cap_2, cap_3, cap_4, cap_5, cap_6");
  const slotMap = {};
  (slots || []).forEach(s => { slotMap[String(s.id)] = s; });
  const { data: lim } = await sb.from("facility_limits").select("*");
  const limMap = {};
  (lim || []).forEach(f => { limMap[f.facility_name] = f.max_total; });
  const { data: assigns } = await sb.from("assignments").select("id, student_id, course_number, slot_id");
  const used = {}, facUsed = {};
  (assigns || []).forEach(a => {
    const k = String(a.slot_id) + "_" + a.course_number;
    used[k] = (used[k] || 0) + 1;
    const s = slotMap[String(a.slot_id)];
    if (s) facUsed[s.facility_name + "_" + a.course_number] = (facUsed[s.facility_name + "_" + a.course_number] || 0) + 1;
  });
  const hasRoom = (slotId, c) => {
    const s = slotMap[String(slotId)];
    if (!s) return false;
    if ((used[String(slotId) + "_" + c] || 0) >= (s["cap_" + c] || 0)) return false;
    const l = limMap[s.facility_name];
    if (l != null && (facUsed[s.facility_name + "_" + c] || 0) >= l) return false;
    return true;
  };

  // 偏りのないシャッフル
  const list = (reqs || []).slice();
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }

  const freed = [];
  for (const r of list) {
    const c = Number(r.course_number);
    const cur = (assigns || []).find(a => String(a.student_id) === String(r.student_id) && a.course_number === c);
    const from = slotMap[String(r.from_slot)], to = slotMap[String(r.to_slot)];
    // 申請後に枠が変わっていたり、種類が違う場合は無効
    // allow_cross＝学年代表が個別に認めた「種類の違う枠への移動」の申請（種類のチェックを省く）
    if (!cur || String(cur.slot_id) !== String(r.from_slot) || !from || !to || (!r.allow_cross && moveComboKey(from) !== moveComboKey(to))) {
      await sb.from("move_requests").update({ status: "lost" }).eq("id", r.id);
      continue;
    }
    if (!hasRoom(r.to_slot, c)) {
      await sb.from("move_requests").update({ status: "lost" }).eq("id", r.id);
      continue;
    }
    // 移動した枠は、表の中でトレードと同じ黒字＋🔄で表示する
    let { error } = await sb.from("assignments").update({ slot_id: r.to_slot, lodging_choice: null, swapped: true }).eq("id", cur.id);
    if (error) ({ error } = await sb.from("assignments").update({ slot_id: r.to_slot, lodging_choice: null }).eq("id", cur.id));
    if (error) { await sb.from("move_requests").update({ status: "lost" }).eq("id", r.id); continue; }
    await sb.from("move_requests").update({ status: "won" }).eq("id", r.id);
    // 使用数を更新（移動先+1、移動元-1）
    const kTo = String(r.to_slot) + "_" + c, kFrom = String(r.from_slot) + "_" + c;
    used[kTo] = (used[kTo] || 0) + 1;
    used[kFrom] = Math.max(0, (used[kFrom] || 0) - 1);
    facUsed[to.facility_name + "_" + c] = (facUsed[to.facility_name + "_" + c] || 0) + 1;
    facUsed[from.facility_name + "_" + c] = Math.max(0, (facUsed[from.facility_name + "_" + c] || 0) - 1);
    cur.slot_id = r.to_slot;
    freed.push({ slot_id: String(r.from_slot), course: c });
  }

  // 空いた枠（処理後にまだ空きがあるもの）を記録してアナウンスに使う
  const seen = new Set();
  const announce = [];
  for (const f of freed) {
    const key = f.slot_id + "_" + f.course;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hasRoom(f.slot_id, f.course)) {
      const s = slotMap[f.slot_id];
      announce.push({ slot_id: f.slot_id, course: f.course, facility_name: s.facility_name, department_name: s.department_name, combo: moveComboKey(s) });
    }
  }
  await sb.from("move_runs").update({ status: "done", freed: announce, done_at: new Date().toISOString() }).eq("id", run.id);
};
