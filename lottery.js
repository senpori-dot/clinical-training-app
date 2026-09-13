// ============================================================
// 抽選の共通ロジック（学生ページ・管理画面の両方から呼び出す）
// ============================================================
// ラウンドは「第◯希望」というランク。学生は①〜⑥のうちまだ決まっていない
// クールの中から自由に(実習先, クール)の組を選んで希望を出す。
// 締切を過ぎたら、(実習先, クール)ごとに集計して定員超過分を抽選する。
window.tryRunLotteryIfDue = async function (sb, round) {
  if (!round) return round;
  const now = new Date();

  let phaseToProcess = null;
  if (round.phase === "first_choice" && round.end_at && now > new Date(round.end_at)) {
    phaseToProcess = "first_choice";
  } else if (round.phase === "second_match" && round.second_deadline && now > new Date(round.second_deadline)) {
    phaseToProcess = "second_match";
  }
  if (!phaseToProcess) return round;

  const lockPhase = phaseToProcess + "_processing";
  const { data: locked } = await sb
    .from("rounds")
    .update({ phase: lockPhase })
    .eq("id", round.id)
    .eq("phase", phaseToProcess)
    .select();

  if (!locked || locked.length === 0) {
    const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
    return fresh || round;
  }

  await window.runLotteryCore(sb, round, phaseToProcess);

  const { data: fresh } = await sb.from("rounds").select("*").eq("id", round.id).maybeSingle();
  return fresh || round;
};

// 実際の抽選処理本体：(実習先, クール)ごと、かつ施設全体の人数上限も考慮したグローバル抽選
// ※ 他のラウンドで既に確定している人数もベースとして考慮し、定員を絶対に超えないようにする
window.runLotteryCore = async function (sb, round, phaseToProcess) {
  const attempt = phaseToProcess === "second_match" ? 2 : 1;

  const { data: prefs, error: prefsErr } = await sb
    .from("preferences")
    .select("id, student_id, slot_id, course_number, status")
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
    .select("id, facility_name, cap_1, cap_2, cap_3, cap_4, cap_5, cap_6");
  if (slotsErr) console.error("slots fetch error", slotsErr);
  const slotMap = {};
  (allSlots || []).forEach(s => { slotMap[s.id] = s; });

  // 既に確定済み（他のラウンドを含む全体）の人数をベースラインとして読み込む
  const { data: existingAssignments, error: existingErr } = await sb
    .from("assignments")
    .select("slot_id, course_number");
  if (existingErr) console.error("assignments fetch error", existingErr);

  const slotCourseCount = {};
  const facilityCourseCount = {};
  for (const a of (existingAssignments || [])) {
    const slotKey = a.slot_id + "_" + a.course_number;
    slotCourseCount[slotKey] = (slotCourseCount[slotKey] || 0) + 1;
    const fname = slotMap[a.slot_id] && slotMap[a.slot_id].facility_name;
    if (fname) {
      const facKey = fname + "_" + a.course_number;
      facilityCourseCount[facKey] = (facilityCourseCount[facKey] || 0) + 1;
    }
  }

  const shuffled = (prefs || []).slice().sort(() => Math.random() - 0.5);
  let confirmedCount = 0, lostCount = 0;

  for (const p of shuffled) {
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

    if (curSlot < cap && (!facLimit || curFac < facLimit)) {
      await sb.from("preferences").update({ status: "confirmed" }).eq("id", p.id);
      await sb.from("assignments").upsert(
        { student_id: p.student_id, course_number: p.course_number, slot_id: p.slot_id },
        { onConflict: "student_id,course_number" }
      );
      slotCourseCount[slotKey] = curSlot + 1;
      facilityCourseCount[facKey] = curFac + 1;
      confirmedCount++;
    } else {
      await sb.from("preferences").update({ status: "lost" }).eq("id", p.id);
      lostCount++;
    }
  }

  const nextPhase = phaseToProcess === "first_choice"
    ? (lostCount > 0 ? "second_match" : "closed")
    : "closed";

  await sb.from("rounds").update({ phase: nextPhase }).eq("id", round.id);

  return { confirmedCount, lostCount, nextPhase };
};
