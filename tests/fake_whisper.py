#!/usr/bin/env python3
# テスト用の whisper-cli 代わり：音声の長さから、どのテスト素材かを当てて決まった文字起こしを返す
import sys, json, wave, os
a = sys.argv
out = a[a.index('-of') + 1]; wav = a[a.index('-f') + 1]
with wave.open(wav) as w: dur = w.getnframes() / w.getframerate()
here = os.path.dirname(os.path.abspath(__file__))
sched = json.load(open(os.path.join(here, 'media/sched.json')))
durs = {'T001.wav': 10.5, 'T002.wav': 10.3, 'A001C001.mov': 10.0, 'A001C002.mov': 10.0, 'B001C001.mp4': 9.2, 'B001C002.mp4': 8.9}
name = min(durs, key=lambda k: abs(durs[k] - dur))
print('progress = 50%', flush=True)
tr = [{'offsets': {'from': int(s['start'] * 1000), 'to': int(s['end'] * 1000)}, 'text': s['text']} for s in sched[name]]
# 無音部分の作文（取り除かれるべき）
tr.append({'offsets': {'from': int((dur - 0.9) * 1000), 'to': int(dur * 1000)}, 'text': 'ご視聴ありがとうございました'})
json.dump({'transcription': tr}, open(out + '.json', 'w'), ensure_ascii=False)
print('progress = 100%', flush=True)
