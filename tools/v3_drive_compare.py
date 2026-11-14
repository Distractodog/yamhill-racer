"""Compare DRIVE output against two measured baselines, without invented tolerance.

Only the actual printed variants observed in the two baseline runs are allowed.
Baseline disagreement is itself a failed repeatability gate. Full baseline logs
must contain 97 sections; use explicit count options only for smaller fixtures.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

HEADER = re.compile(r'^== (.+): 0-100 (?:[\d.]+s|—), flips \d+, longest air [\d.]+s(?:, NaN!)?$', re.M)
FOCUS = ('60 s wander over campus hills', 'walls: bot drives North woods scramble',
         'jet: take-off run on Hwy 18', 'jet: approach + landing on Hwy 18')


def parse(text):
    matches = list(HEADER.finditer(text))
    result = {}
    for i, match in enumerate(matches):
        name = match[1]
        if name in result:
            raise ValueError('Duplicate DRIVE section: '+name)
        block = text[match.start():matches[i+1].start() if i+1 < len(matches) else len(text)]
        # Node emits this known startup/runtime warning after the last case.
        # Remove only its two known lines, not arbitrary error output.
        block = re.sub(r'^\(node:\d+\) Warning: `--localstorage-file` was provided without a valid path\n?', '', block, flags=re.M)
        block = re.sub(r'^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n?', '', block, flags=re.M)
        result[name] = block.strip()
    return result


def metrics(block):
    patterns = {'flips': r', flips (\d+)', 'longestAirSeconds': r'longest air ([\d.]+)s',
                'accel100Seconds': r': 0-100 ([\d.]+)s',
                'finishSeconds': r'(?:reached the finish|finished) in ([\d.]+) s',
                'progressPercent': r'got to ([\d.]+)%', 'backups': r'backed up (\d+)×',
                'wallContacts': r'wall contact (\d+) steps',
                'liftOffSpeedKmh': r'lift-off ([\d.]+) km/h',
                'liftOffDistanceMetres': r'lift-off [\d.]+ km/h after ([\d.]+) m'}
    result = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, block)
        if match:
            result[key] = float(match[1])
    for mode in ('air', 'ground', 'crashed'):
        result[mode+'Entries'] = len(re.findall(r'(?:→|   )'+mode+'@', block))
    result['failure'] = bool(re.search(r'DID NOT FINISH|NaN!|\bFAIL(?:ED)?\b', block))
    return result


def compare(baseline1, baseline2, candidate, baseline_count=97, expected_count=97, allow_subset=False):
    b1, b2, current = map(parse, (baseline1, baseline2, candidate))
    errors = []
    if len(b1) != baseline_count or len(b2) != baseline_count or b1.keys() != b2.keys():
        errors.append('Incomplete or inconsistent baseline section coverage')
    if len(current) != expected_count:
        errors.append('Candidate section count does not match expected count')
    if not current.keys() <= b1.keys() or (not allow_subset and current.keys() != b1.keys()):
        errors.append('Candidate section names do not match required baseline coverage')
    noise = [name for name in b1.keys() | b2.keys() if b1.get(name) != b2.get(name)]
    if noise:
        errors.append('Baseline repeatability failed: observed section differences')
    changes, failures, flips = [], [], []
    for name, block in current.items():
        original1, original2 = b1.get(name, ''), b2.get(name, '')
        if block not in (original1, original2):
            changes.append(name)
        bm, cm = metrics(original1), metrics(block)
        if cm['failure'] and not metrics(original1)['failure'] and not metrics(original2)['failure']:
            failures.append(name)
        if bm.get('flips') != cm.get('flips'):
            flips.append({'section': name, 'before': bm.get('flips'), 'after': cm.get('flips')})
    if changes:
        errors.append('Candidate differs beyond the exact printed baseline observations')
    return {'passed': not errors, 'errors': errors, 'baselineSections': [len(b1), len(b2)],
            'candidateSections': len(current), 'expectedSections': expected_count,
            'allowSubset': allow_subset, 'baselineNoiseSections': sorted(noise),
            'changedSections': changes, 'newFailures': failures, 'flipChanges': flips,
            'focusMetrics': {name: {'before': metrics(b1[name]), 'after': metrics(current[name])}
                             for name in FOCUS if name in b1 and name in current},
            'policy': 'No numeric tolerance. Baseline disagreement fails repeatability; candidate section text must match an observed baseline. Process exit status must also be checked separately.'}


def file_info(path):
    raw = path.read_bytes()
    return {'filename': path.name, 'sha256': hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline1', type=Path)
    parser.add_argument('baseline2', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--baseline-count', type=int, default=97)
    parser.add_argument('--expected-count', type=int, default=97)
    parser.add_argument('--allow-subset', action='store_true')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.baseline_count < 1 or args.expected_count < 1:
        parser.error('Section counts must be positive')
    try:
        report = compare(*(p.read_text() for p in (args.baseline1, args.baseline2, args.candidate)),
                         args.baseline_count, args.expected_count, args.allow_subset)
        report['inputs'] = {key: file_info(path) for key, path in
                            [('baseline1', args.baseline1), ('baseline2', args.baseline2), ('candidate', args.candidate)]}
    except (ValueError, OSError) as error:
        # Avoid publishing a local path from filesystem exception text.
        report = {'passed': False, 'errors': [str(error) if isinstance(error, ValueError) else 'Unable to read an input file']}
    encoded = json.dumps(report, indent=2, ensure_ascii=False)+'\n'
    if args.out:
        args.out.write_text(encoded)
    print(encoded, end='')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
