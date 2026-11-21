import numpy as np, subprocess, json, os, wave
SR=48000
rng=np.random.default_rng(1)
def utter(dur, f0, seed):
    r=np.random.default_rng(seed)
    n=int(dur*SR); t=np.arange(n)/SR
    # 音節っぽい振幅
    syl=np.clip(np.sin(2*np.pi*7*t+r.uniform(0,6))*0.5+0.6,0,1)
    env=np.minimum(1,np.minimum(t/0.03,(dur-t)/0.05))*syl
    sig=sum(np.sin(2*np.pi*f0*k*t*(1+0.03*np.sin(2*np.pi*3*t)))/k for k in range(1,8))
    sig+=r.normal(0,0.3,n)
    return (sig*env*0.25).astype(np.float32)
# 場面のテイク：発話（話者、セリフ、開始、長さ）
takes={
 1:[('A','ふざけんなよ',1.5,0.9),('A','あいつのこと',3.0,0.8),('A','忘れんなよ',4.15,0.8),('B','そうだけど',6.0,0.7),('B','まあ、いいじゃん',7.2,0.8)],
 2:[('A','ふざけんなよ',1.2,0.8),('A','あいつのことを忘れんなよ',2.5,1.5),('B','そうだけど',5.0,0.8)],
}
F0={'A':140,'B':210}
master={}
for k,u in takes.items():
    L=10.0
    x=np.zeros(int(L*SR),np.float32)
    for i,(spk,txt,st,d) in enumerate(u):
        s=int(st*SR); y=utter(d,F0[spk],k*10+i); x[s:s+len(y)]+=y
    master[k]=x
# 素材：(フォルダ, 名前, テイク, 開始ずれ, 形式)
files=[('A','A001C001.mov',1,0.0,'prores'),('B','B001C001.mp4',1,0.8,'h264'),('音声','T001.wav',1,-0.5,'wav'),
       ('A','A001C002.mov',2,0.0,'prores'),('B','B001C002.mp4',2,1.1,'h264'),('音声','T002.wav',2,-0.3,'wav')]
os.chdir(os.path.dirname(os.path.abspath(__file__))); os.makedirs('media',exist_ok=True)
sched={}
for d,name,tk,off,fmt in files:
    os.makedirs('media/'+d,exist_ok=True)
    x=master[tk]
    s=int(max(0,off)*SR)
    y=x[s:]
    if off<0: y=np.concatenate([np.zeros(int(-off*SR),np.float32),x])
    y=y+rng.normal(0,0.004 if fmt=='wav' else 0.012,len(y)).astype(np.float32)
    g=1.0 if fmt=='wav' else 0.6
    pcm=(np.clip(y*g,-1,1)*32767).astype(np.int16)
    raw='/tmp/a.raw'; pcm.tofile(raw)
    dur=len(y)/SR
    out='media/%s/%s'%(d,name)
    if fmt=='wav':
        subprocess.run(['ffmpeg','-y','-loglevel','error','-f','s16le','-ar',str(SR),'-ac','1','-i',raw,'-c:a','pcm_s24le','-ac','2',out],check=True)
    elif fmt=='prores':
        subprocess.run(['ffmpeg','-y','-loglevel','error','-f','lavfi','-i','testsrc2=s=960x540:r=24000/1001:d=%f'%dur,'-f','s16le','-ar',str(SR),'-ac','1','-i',raw,'-c:v','prores_ks','-profile:v','0','-c:a','pcm_s16le','-ac','2','-timecode','01:00:00:00','-shortest',out],check=True)
    else:
        subprocess.run(['ffmpeg','-y','-loglevel','error','-f','lavfi','-i','testsrc=s=640x360:r=30000/1001:d=%f'%dur,'-f','s16le','-ar',str(SR),'-ac','1','-i',raw,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-shortest',out],check=True)
    # 文字起こしの模擬（素材の時刻）
    segs=[]
    for spk,txt,st,dd in takes[tk]:
        t=st-off
        segs.append({'start':round(t-0.1,3),'end':round(t+dd+0.1,3),'text':txt})
    sched[name]=segs
json.dump(sched,open('media/sched.json','w'),ensure_ascii=False)
print('ok')
