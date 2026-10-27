import React, {useEffect, useRef, useState} from 'react';
import {encodeReferenceWav} from './reference-wav';

type Props = {
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onReset: () => void;
  onUpload: (file: File, signal: AbortSignal) => Promise<void>;
};
type Phase = 'idle' | 'requesting' | 'recording' | 'processing' | 'uploading' | 'uploaded' | 'error';
type Capture = {stream?: MediaStream; recorder?: MediaRecorder; context?: AudioContext; timer?: ReturnType<typeof setInterval>};

export function ReferenceAudioInput({disabled, onBusy, onReset, onUpload}: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [file, setFile] = useState<File>();
  const capture = useRef<Capture>({});
  const generation = useRef(0);
  const previewUrl = useRef('');
  const lock = useRef(false);
  const uploadController = useRef<AbortController | undefined>(undefined);

  const release = () => {
    const current = capture.current;
    capture.current = {};
    clearInterval(current.timer);
    if (current.recorder) {
      current.recorder.onstop = null;
      current.recorder.onerror = null;
      current.recorder.ondataavailable = null;
      if (current.recorder.state !== 'inactive') current.recorder.stop();
    }
    current.stream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    if (current.context) void current.context.close().catch(() => {});
  };
  const clearPreview = () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = '';
    setPreview(''); setFile(undefined);
  };
  const cancel = (message = '') => {
    generation.current++; release(); lock.current = false;
    onBusy(false); setPhase(message ? 'error' : 'idle'); setError(message); setSeconds(0);
  };
  useEffect(() => {
    const hide = () => {
      if (document.hidden && capture.current.stream) cancel('录音已暂停并丢弃，请回到页面后重新录制。');
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      generation.current++; release();
      uploadController.current?.abort();
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  const upload = async (recorded: File, turn: number) => {
    setFile(recorded);
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(recorded); setPreview(previewUrl.current);
    setPhase('uploading'); setError('');
    const controller = new AbortController();
    uploadController.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('上传超过 60 秒，请检查网络后重试', 'TimeoutError')), 60000);
    try {
      await onUpload(recorded, controller.signal);
      controller.signal.throwIfAborted();
      if (generation.current === turn) setPhase('uploaded');
    } catch (e) {
      const message = controller.signal.aborted
        ? (controller.signal.reason?.name === 'TimeoutError' ? '上传超过 60 秒，请检查网络后重试' : '已取消上传')
        : (e as Error).message;
      if (generation.current === turn) {setPhase('error'); setError(`${message}。录音已保留，可重试上传或下载保存。`);}
    } finally {
      clearTimeout(timeout);
      if (uploadController.current === controller) uploadController.current = undefined;
      if (generation.current === turn) {lock.current = false; onBusy(false);}
    }
  };
  const uploadExisting = async (selected:File,turn:number) => {
    setPhase('processing');setError('');
    let context:AudioContext|undefined;
    try {
      const Ctx=window.AudioContext??(window as Window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!Ctx)throw new Error('当前浏览器不支持转换音频，请使用新版 Safari 或 Chrome');
      context=new Ctx();
      const decoded=await context.decodeAudioData(await selected.arrayBuffer());
      if(turn!==generation.current)return;
      if(decoded.duration<1)throw new Error('音频不足 1 秒，请提供清晰的 20–30 秒录音');
      // Match microphone recordings: mono PCM, 24 kHz, at most 25 seconds.
      const duration=Math.min(decoded.duration,25);
      const renderer=new OfflineAudioContext(1,Math.ceil(duration*24000),24000);
      const source=renderer.createBufferSource();source.buffer=decoded;source.connect(renderer.destination);source.start(0,0,duration);
      const normalized=await renderer.startRendering();
      if(turn!==generation.current)return;
      await upload(new File([encodeReferenceWav([normalized.getChannelData(0)],24000)],'reference-upload.wav',{type:'audio/wav'}),turn);
    }catch(e){if(turn===generation.current)cancel(`音频转换失败：${(e as Error).message}`);}
    finally{if(context)await context.close().catch(()=>{});}
  };
  const finish = () => {
    const current = capture.current;
    if (current.recorder?.state !== 'recording') return;
    clearInterval(current.timer);
    setPhase('processing');
    current.recorder.stop();
    // Release the microphone as soon as the user finishes, before decode/upload.
    current.stream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    current.stream = undefined;
  };
  const start = async () => {
    if (disabled || lock.current) return;
    lock.current = true;
    const turn = ++generation.current;
    onBusy(true); onReset(); clearPreview(); setError(''); setSeconds(0); setPhase('requesting');
    try {
      if (!window.isSecureContext) throw new Error('直接录音需要 HTTPS，请使用网站的 HTTPS 地址');
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持直接录音，请使用新版 Safari / Chrome 或上传音频文件');
      const Ctx = window.AudioContext ?? (window as Window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
      if (!Ctx) throw new Error('当前浏览器不支持处理录音，请改用上传文件');
      const context = new Ctx(); capture.current.context = context;
      await context.resume();
      if (turn !== generation.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
      if (turn !== generation.current) {stream.getTracks().forEach(track => track.stop()); return;}
      capture.current.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
      capture.current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
      recorder.onerror = () => {if (turn === generation.current) cancel('录音中断，请重录或上传音频文件。');};
      stream.getTracks().forEach(track => {track.onended = () => {if (turn === generation.current) cancel('麦克风已断开，请重新录制。');};});
      recorder.onstop = () => {void (async () => {
        if (turn !== generation.current) return;
        try {
          const decoded = await context.decodeAudioData(await new Blob(chunks, {type:recorder.mimeType}).arrayBuffer());
          if (turn !== generation.current) return;
          if (decoded.duration < 1) throw new Error('录音不足 1 秒，请重新录制，建议说话 20–30 秒');
          // Stay within Linx's 20–30s recommendation and use the verified
          // mono 24kHz PCM format, independent of the microphone's sample rate.
          const duration=Math.min(decoded.duration,25);
          const renderer=new OfflineAudioContext(1,Math.ceil(duration*24000),24000);
          const source=renderer.createBufferSource();source.buffer=decoded;source.connect(renderer.destination);source.start(0,0,duration);
          const normalized=await renderer.startRendering();
          if(turn!==generation.current)return;
          const wav = encodeReferenceWav([normalized.getChannelData(0)],24000);
          release();
          await upload(new File([wav], 'reference-recording.wav', {type:'audio/wav'}), turn);
        } catch (e) {
          if (turn === generation.current) cancel((e as Error).message);
        }
      })();};
      recorder.start(1000); setPhase('recording');
      const started = performance.now();
      capture.current.timer = setInterval(() => {
        const elapsed = Math.floor((performance.now() - started) / 1000);
        setSeconds(Math.min(elapsed, 25));
        if (elapsed >= 25) finish();
      }, 250);
    } catch (e) {
      if (turn !== generation.current) return;
      const failure = e as Error;
      cancel(failure.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器中允许本站使用麦克风后重试。'
        : failure.name === 'NotFoundError' ? '未找到麦克风，请连接设备或上传音频文件。' : failure.message);
    }
  };

  return <div className="reference-recorder" style={{margin:'16px 0'}}>
    <p>直接说话约 20–25 秒，结束后自动上传。录满 25 秒会自动结束，并转换为适合复刻的标准音频。</p>
    <div className="voice-buttons">
      {phase === 'recording' ? <><button type="button" className="recording" onClick={finish}>结束录音并上传</button><button type="button" className="secondary" onClick={() => cancel()}>取消录音</button></>
        : phase === 'requesting' ? <button type="button" className="secondary" onClick={() => cancel()}>取消等待麦克风</button>
        : <button type="button" disabled={disabled || lock.current} onClick={() => void start()}>{file ? '重新录音' : '开始录音'}</button>}
      {phase === 'uploading' && <button type="button" className="secondary" onClick={() => uploadController.current?.abort()}>取消上传，保留录音</button>}
      {phase === 'error' && file && <button type="button" disabled={disabled} onClick={() => {
        if (lock.current) return;
        lock.current = true; onBusy(true); void upload(file, ++generation.current);
      }}>重试上传</button>}
    </div>
    <p role="status">{phase === 'requesting' ? '请允许使用麦克风…' : phase === 'recording' ? `正在录音 · ${seconds} 秒`
      : phase === 'processing' ? '正在处理录音…' : phase === 'uploading' ? '正在上传参考音频…'
      : phase === 'uploaded' ? '参考音频已上传，可以试听或点击下方“开始复刻”。' : ''}</p>
    {error && <p role="alert" className="warning">{error}</p>}
    {preview && <audio aria-label="参考声音试听" controls src={preview} style={{width:'100%',marginBottom:12}}/>}
    {preview && file && <p><a className="button secondary" href={preview} download={file.name}>下载参考音频</a></p>}
    <label>或上传已有音频文件（自动转为单声道 WAV，最多保留前 25 秒）<input type="file" accept=".wav,.mp3,.m4a" disabled={disabled || lock.current} onChange={event => {
      const selected = event.target.files?.[0]; event.target.value = '';
      if (!selected || lock.current) return;
      if (selected.size > 15 * 1024 * 1024) {setError('音频文件不能超过 15 MB'); return;}
      lock.current = true; onBusy(true); onReset(); clearPreview();
      void uploadExisting(selected, ++generation.current);
    }}/></label>
  </div>;
}
