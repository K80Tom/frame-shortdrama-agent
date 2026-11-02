#!/usr/bin/env python3
"""从 awesome-short-drama-skills 清单批量导入提示词方法包。

只下载文本（SKILL.md / LICENSE），不执行任何第三方代码。
许可分层：可整合（MIT/Apache/CC0/CC-BY 等）与 CC BY-NC（标记非商用）入库；
无许可或清单标注为完整应用的条目仅登记为参考，不复制内容。

用法：python3 import-prompt-packs.py <awesome-repo-dir> <prompt-library-dir>
"""
import ast
import concurrent.futures
import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

STAGE_MAP = {
    'selection': 'topic', 'ip': 'topic', 'topic': 'topic',
    'adaptation': 'adaptation', 'character': 'character',
    'structure': 'episode-outline', 'outline': 'episode-outline',
    'drafting': 'script', 'script': 'script',
    'revision': 'script-review', 'review': 'script-review',
    'storyboard': 'storyboard', 'prompt': 'video-prompt',
    'production': 'production',
}
OK_LICENSES = ('mit', 'apache', 'cc0', 'cc-by-4', 'cc by 4', 'bsd', 'isc', 'mit-0', 'unlicense')
USER_AGENT = 'lyra-prompt-library-importer/1.0'


def parse_skills_toml(text):
    """解析结构规整的 skills.toml（[[skills]] 块 + key = value）。"""
    entries = []
    for block in re.split(r'\n\[\[skills\]\]\n', text)[1:]:
        entry = {}
        for line in block.splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, raw = line.partition('=')
            key, raw = key.strip(), raw.strip()
            if raw.startswith(('#',)):
                continue
            # 去掉行内注释（仅当 # 前有空格且不在引号/数组内）
            if raw.startswith('['):
                value = ast.literal_eval(raw)
            elif raw.startswith('"'):
                value = ast.literal_eval(raw)
            elif raw in ('true', 'false'):
                value = raw == 'true'
            else:
                continue  # 日期等不需要的字段
            entry[key] = value
        if entry.get('repo'):
            entries.append(entry)
    return entries


def license_kind(license_name):
    if not license_name:
        return 'none'
    low = license_name.lower()
    if 'nc' in low.replace('noncommercial', 'nc'):
        return 'restricted'
    if any(token in low for token in OK_LICENSES):
        return 'ok'
    if low in ('none', 'noassertion', 'unknown', ''):
        return 'none'
    return 'unknown'


def fetch(url, timeout=25, retries=3):
    last_error = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode('utf-8', 'replace')
        except Exception as exc:  # 网络瞬断/SSL 抖动，退避重试
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise last_error


def raw_url(repo, branch, path):
    return f'https://raw.githubusercontent.com/{repo}/{branch}/{path}'


def slug(text):
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def main(source_dir, library_dir):
    source = Path(source_dir)
    library = Path(library_dir)
    packs_root = library / 'packs'
    packs_root.mkdir(parents=True, exist_ok=True)

    skills_meta = {e['repo']: e for e in parse_skills_toml((source / 'data/skills.toml').read_text())}
    skill_index = json.loads((source / 'data/skill_index.json').read_text())['repos']
    repo_meta = json.loads((source / 'data/meta.json').read_text())['repos']
    awesome_commit = __import__('subprocess').check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()

    report = {'imported': [], 'restricted': [], 'reference_only': [], 'applications': [], 'failed': []}
    index_packs = []

    def process(repo):
        meta = skills_meta.get(repo, {})
        index = skill_index.get(repo) or {}
        rm = repo_meta.get(repo, {})
        license_name = (rm.get('license') or '').strip()
        kind = license_kind(license_name)
        fmt = meta.get('format', 'skill')
        stages = sorted({STAGE_MAP[s] for s in meta.get('stages', []) if s in STAGE_MAP})
        models = meta.get('models') or ['*']
        branch = index.get('branch') or 'main'
        skills = index.get('skills') or []
        base = {
            'source': {'repository': repo, 'url': f'https://github.com/{repo}', 'branch': branch},
            'awesome': {'stages': meta.get('stages', []), 'group': meta.get('group'), 'tier': meta.get('tier')},
        }
        if fmt == 'app':
            return ('applications', {'repo': repo, 'desc': meta.get('desc', ''), 'url': base['source']['url']})
        if kind in ('none', 'unknown') or not skills:
            return ('reference_only', {'repo': repo, 'license': license_name or '未声明', 'url': base['source']['url'],
                                       'reason': '未声明许可' if kind != 'ok' else '未找到 SKILL.md'})

        packs = []
        for skill in skills:
            pack_id = slug(f"{repo.replace('/', '-')}-{skill.get('name') or 'skill'}")
            pack_dir = packs_root / pack_id
            pack_dir.mkdir(parents=True, exist_ok=True)
            rel = skill.get('path') or 'SKILL.md'
            try:
                content = fetch(raw_url(repo, branch, rel))
            except Exception as exc:
                return ('failed', {'repo': repo, 'skill': skill.get('name'), 'error': str(exc)[:120]})
            (pack_dir / 'content').mkdir(exist_ok=True)
            (pack_dir / 'content' / 'SKILL.md').write_text(content)
            license_text = None
            for candidate in ('LICENSE', 'LICENSE.md', 'LICENSE.txt'):
                try:
                    license_text = fetch(raw_url(repo, branch, candidate), timeout=12)
                    break
                except Exception:
                    continue
            if license_text:
                (pack_dir / 'LICENSE').write_text(license_text)
            pack = {
                'id': pack_id,
                'name': skill.get('name') or pack_id,
                'version': 'synced',
                'summary': meta.get('desc', ''),
                'stages': stages,
                'models': models,
                'license': license_name or '未声明',
                'commercialUseAllowed': kind == 'ok',
                'contentPolicy': 'imported',
                'quality': 'unevaluated',
                'enabledByDefault': False,
                'entry': 'content/SKILL.md',
            }
            (pack_dir / 'pack.json').write_text(json.dumps(pack, ensure_ascii=False, indent=2) + '\n')
            (pack_dir / 'source.json').write_text(json.dumps({
                **base['source'], 'path': rel,
                'via': 'UnderleveledBuilder/awesome-short-drama-skills',
                'awesomeCommit': awesome_commit,
                'syncedAt': time.strftime('%Y-%m-%d'),
                'note': '仅文本；未引入任何第三方脚本。' + ('' if license_text else ' 未在仓库根找到 LICENSE 文件。'),
            }, ensure_ascii=False, indent=2) + '\n')
            packs.append({k: pack[k] for k in ('id', 'name', 'stages', 'models', 'license', 'quality',
                                               'enabledByDefault', 'contentPolicy', 'commercialUseAllowed')})
        return ('restricted' if kind == 'restricted' else 'imported',
                {'repo': repo, 'license': license_name, 'packs': packs})

    # screenwriter-skill 已在试点中手工导入（含 references/templates），避免重复
    repos = sorted((set(skills_meta) | set(skill_index)) - {'Vi7QY/screenwriter-skill'})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for category, payload in pool.map(process, repos):
            report[category].append(payload)
            if category in ('imported', 'restricted'):
                index_packs.extend(payload['packs'])

    # 重新扫描 packs 目录，纳入此前已存在的手工试点包
    index_packs = []
    index_keys = ('id', 'name', 'stages', 'models', 'license', 'quality',
                  'enabledByDefault', 'contentPolicy', 'commercialUseAllowed')
    for pack_dir in sorted(packs_root.iterdir()):
        manifest = pack_dir / 'pack.json'
        if manifest.exists():
            pack = json.loads(manifest.read_text())
            index_packs.append({k: pack[k] for k in index_keys if k in pack})

    index = {
        'version': 1,
        'source': 'UnderleveledBuilder/awesome-short-drama-skills',
        'awesomeCommit': awesome_commit,
        'stages': ['topic', 'adaptation', 'character', 'episode-outline', 'script', 'script-review',
                   'storyboard', 'video-prompt', 'production'],
        'packs': sorted(index_packs, key=lambda p: p['id']),
        'referenceOnly': report['reference_only'],
        'applications': report['applications'],
    }
    (library / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
    (library / 'import-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    print(json.dumps({
        '可整合入库仓库': len(report['imported']),
        '非商用受限仓库': len(report['restricted']),
        '仅参考(无许可等)': len(report['reference_only']),
        '完整应用(仅链接)': len(report['applications']),
        '导入失败': report['failed'],
        '方法包总数': len(index_packs),
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
