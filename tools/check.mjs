#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거·글로벌 비교 칸(R10), 근거 키가 sources.md에 있음(R11),
// 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "경계·연결", "근거"];
const RELEASE = process.argv.includes("--release");
const CITED = ["국내 근거", "글로벌 비교", "근거"];

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const cites = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([OLNX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    if (fields["조건부 선수"]) for (const m of fields["조건부 선수"].matchAll(/([OLNX]\d+)\(/g)) prereq.push(m[1]);
    modules.set(id, prereq);
    for (const name of CITED) if (fields[name]) cites.push(...citeKeys(fields[name]).map((k) => [id, name, k]));
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, problems, cites };
}

// 근거 칸의 항목은 「;」로 나뉘고, 각 항목에서 「 — 」 앞이 근거 키다.
// 「직접 규율하는 법령 없음」으로 시작하는 항목은 키가 아니다.
function citeKeys(value) {
  return value.split(";").map((s) => s.split(" — ")[0].trim()).filter((k) => k && !k.startsWith("직접 규율하는 법령 없음"));
}

// sources.md 행: | `키` | 요지 | 원문 발췌 | URL | 조회일 | 출처 종류 | 개정 잦음 |
function sourceKeys(text, problems) {
  const keys = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\| `([^`]+)` \|/);
    if (!m) continue;
    const key = m[1];
    if (keys.has(key)) problems.push(`sources.md: 중복 키 「${key}」`);
    keys.add(key);
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 7) { problems.push(`sources.md 「${key}」: 칸 수 ${cells.length}(7이어야 함)`); continue; }
    const [, gist, excerpt, url, date, kind] = cells;
    if (!gist) problems.push(`sources.md 「${key}」: 요지 없음`);
    if (!excerpt) problems.push(`sources.md 「${key}」: 원문 발췌 없음`);
    if (!/https?:\/\//.test(url)) problems.push(`sources.md 「${key}」: URL 없음`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`sources.md 「${key}」: 조회일 형식 오류`);
    if (!kind) problems.push(`sources.md 「${key}」: 출처 종류 없음`);
    if (RELEASE && kind.includes("재확인 필요")) problems.push(`sources.md 「${key}」: 재확인 필요 표시가 남음(출고 불가)`);
  }
  return keys;
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, problems, cites } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  const known = existsSync(join(root, "curriculum/sources.md")) ? sourceKeys(read("curriculum/sources.md"), errors) : new Set();
  if (known.size === 0) errors.push("curriculum/sources.md 근거 표 없음");
  for (const [id, field, key] of cites) if (!known.has(key)) errors.push(`${id} ${field}: sources.md에 없는 근거 「${key}」`);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 근거 인용 ${cites.length}개(키 ${known.size}개), 파일 ${files.length}개 검사`);
}

main();
