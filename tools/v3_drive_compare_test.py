import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from v3_drive_compare import compare


def case(name='example', flips=0, finish=10):
    return f'== {name}: 0-100 1.2s, flips {flips}, longest air 0.11s\n   reached the finish in {finish} s\n\n'


class DriveCompareTest(unittest.TestCase):
    def test_identical(self):
        text=case()
        self.assertTrue(compare(text,text,text,1,1)['passed'])
    def test_incomplete_baseline(self):
        text=case()
        self.assertFalse(compare(text,text,text,2,1)['passed'])
    def test_noise_is_not_permission_to_pass(self):
        report=compare(case(),case(finish=11),case(finish=11),1,1)
        self.assertFalse(report['passed'])
        self.assertEqual(report['baselineNoiseSections'],['example'])
    def test_new_failure_and_flip(self):
        text=case(flips=1).replace('reached the finish in 10 s','DID NOT FINISH (got to 35%)')
        report=compare(case(),case(),text,1,1)
        self.assertFalse(report['passed'])
        self.assertEqual(report['newFailures'],['example'])
        self.assertEqual(report['flipChanges'][0]['after'],1)
    def test_subset_requires_explicit_flag_and_count(self):
        base=case('one')+case('two');one=case('one')
        self.assertFalse(compare(base,base,one,2,1)['passed'])
        self.assertTrue(compare(base,base,one,2,1,True)['passed'])
        self.assertFalse(compare(base,base,one,2,2,True)['passed'])
    def test_duplicate_or_truncated_section_rejected(self):
        with self.assertRaises(ValueError):compare(case()+case(),case(),case(),1,1)
        self.assertFalse(compare(case(),case(),'== example: truncated',1,1)['passed'])
    def test_known_pid_warning_only(self):
        warning='(node:123) Warning: `--localstorage-file` was provided without a valid path\n(Use `node --trace-warnings ...` to show where the warning was created)\n'
        self.assertTrue(compare(case(),case()+warning,case(),1,1)['passed'])
        self.assertFalse(compare(case(),case(),case()+'unexpected failure',1,1)['passed'])
    def test_cli_status_hashes_and_basename(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);files=[root/n for n in ('before1.txt','before2.txt','after.txt')]
            for p in files:p.write_text(case())
            cmd=[sys.executable,str(Path(__file__).with_name('v3_drive_compare.py')),*map(str,files),'--baseline-count','1','--expected-count','1']
            ok=subprocess.run(cmd,capture_output=True,text=True);self.assertEqual(ok.returncode,0,ok.stderr)
            report=json.loads(ok.stdout);self.assertEqual(report['inputs']['candidate']['filename'],'after.txt')
            self.assertEqual(len(report['inputs']['candidate']['sha256']),64);self.assertNotIn(td,ok.stdout)
            files[-1].write_text(case(finish=11));bad=subprocess.run(cmd,capture_output=True,text=True);self.assertEqual(bad.returncode,1)


if __name__=='__main__':unittest.main(verbosity=2)
