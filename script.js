// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i; // URL 인식 패턴

// --- 파일 관련 상수 추가 ---
const TEXT_EXTENSIONS = ['.txt'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif'];
const ALLOWED_EXTENSIONS = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS];

// filesData 구조: { id, name, fullText(텍스트파일 또는 OCR 결과), fileObject(이미지파일 객체), isImage, chunks, isProcessed(청크까지 완료), isOcrProcessing }
let filesData = []; 
let currentFileIndex = -1;
let currentChunkIndex = 0;
let currentCharIndex = 0; // 청크 내 현재 문자 위치
let isSequential = true; // 정주행 기능 상태 (기본값: true)
let wakeLock = null; // Wake Lock 객체
let noSleep = null; // NoSleep.js 객체

// Web Speech API 객체
const synth = window.speechSynthesis;
let currentUtterance = null; // 현재 발화 중인 SpeechSynthesisUtterance 객체
let isPaused = false;
let isSpeaking = false;
let isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent); // 모바일 감지

// DOM 요소 캐시 (let으로 선언하여 DOMContentLoaded에서 할당)
let $fileInput, $fullScreenDropArea, $fileList, $textViewer, $voiceSelect, $rateSlider, $rateDisplay, $playPauseBtn;
let $sequentialReadCheckbox, $clearAllFilesBtn;
const $ = (selector) => document.querySelector(selector); // $ 함수는 유지

// 텍스트 뷰어 초기 안내문
const INITIAL_TEXT_VIEWER_TEXT = '텍스트를 여기에 붙여넣거나(Ctrl+V 또는 Command+V) 파일을 화면에 드래그하여 업로드하세요.';
const INITIAL_TEXT_VIEWER_CONTENT = `<p>${INITIAL_TEXT_VIEWER_TEXT}</p>`;

// --- 초기화 및 이벤트 리스너 ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. DOM 요소 할당 (DOM이 로드된 후에 수행하여 에러 방지)
    $fileInput = $('#file-input'); 
    $fullScreenDropArea = $('#full-screen-drop-area'); 
    $fileList = $('#file-list');
    $textViewer = $('#text-viewer');
    $voiceSelect = $('#voice-select');
    $rateSlider = $('#rate-slider');
    $rateDisplay = $('#rate-display');
    $playPauseBtn = $('#play-pause-btn');
    $sequentialReadCheckbox = $('#sequential-read-checkbox');
    $clearAllFilesBtn = $('#clear-all-files-btn');
    
    // 2. 초기 로직 및 이벤트 리스너 등록
    
    if (!('speechSynthesis' in window)) {
        alert('죄송합니다. 이 브라우저는 Web Speech API를 지원하지 않아 서비스를 이용할 수 없습니다.');
        return;
    }

    if (synth.getVoices().length > 0) {
        populateVoiceList();
    }
    synth.onvoiceschanged = populateVoiceList;

    $fileInput.addEventListener('change', handleFiles);

    setupFullScreenDragAndDrop(); // 전역 드래그 앤 드롭 설정

    $('#play-pause-btn').addEventListener('click', togglePlayPause);
    $('#stop-btn').addEventListener('click', stopReading);
    $('#next-file-btn').addEventListener('click', () => changeFile(currentFileIndex + 1));
    $('#prev-file-btn').addEventListener('click', () => changeFile(currentFileIndex - 1));

    $rateSlider.addEventListener('input', updateRateDisplay);
    $rateSlider.addEventListener('change', () => saveBookmark());

    loadBookmark();

    setupTextViewerClickEvent();
    $textViewer.addEventListener('paste', handlePasteInTextViewer); // 텍스트 뷰어에 paste 이벤트 추가
    
    // 텍스트 뷰어에 포커스 되었을 때 안내문 자동 제거
    $textViewer.addEventListener('focus', clearInitialTextViewerContent);


    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
        saveBookmark();
    });

    if (localStorage.getItem('autumnReaderBookmark')) {
        const bookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));
        isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    }
    $sequentialReadCheckbox.checked = isSequential;

    $clearAllFilesBtn.addEventListener('click', clearAllFiles);
    $fileList.addEventListener('click', handleFileListItemClick);

    setupFileListSortable();

    // 모바일 백그라운드 재생 및 화면 켜둠
    document.addEventListener('visibilitychange', handleVisibilityChange);
});

// --- 목소리 목록 로드 (수정: 한국어 목소리가 없으면 모든 목소리 표시) ---
function populateVoiceList() {
    const voices = synth.getVoices();
    $voiceSelect.innerHTML = '';

    let koreanVoices = [];
    let googleKoreanVoiceName = null;
    let preferredVoiceName = null;
    let selectedVoice = null;

    voices.forEach((voice) => {
        const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
        if (voice.lang.includes('ko')) {
            koreanVoices.push(option);
            if (voice.name.includes('Google') || voice.name.includes('Standard') || voice.name.includes('Wavenet')) {
                googleKoreanVoiceName = voice.name;
            }
        }
    });

    if (koreanVoices.length === 0) {
        // 한국어 목소리가 없으면 모든 목소리 추가 (폴백)
        voices.forEach((voice) => {
            const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
            $voiceSelect.appendChild(option);
        });
    } else {
        koreanVoices.forEach(option => $voiceSelect.appendChild(option));
    }

    if (googleKoreanVoiceName) {
        preferredVoiceName = googleKoreanVoiceName;
    } else if (koreanVoices.length > 0) {
        preferredVoiceName = koreanVoices[0].value;
    }

    const savedBookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));
    if (savedBookmark && savedBookmark.settings && $voiceSelect.querySelector(`option[value="${savedBookmark.settings.voice}"]`)) {
        selectedVoice = savedBookmark.settings.voice;
    } else if (preferredVoiceName) {
        selectedVoice = preferredVoiceName;
    } else if ($voiceSelect.options.length > 0) {
        selectedVoice = $voiceSelect.options[0].value; // 기본값 설정
    }

    if (selectedVoice) {
        $voiceSelect.value = selectedVoice;
    }

    if (savedBookmark && savedBookmark.settings) {
        $rateSlider.value = savedBookmark.settings.rate;
    }

    updateRateDisplay();
}

// --- 파일 처리 함수 추가 (누락된 부분 재구성) ---
function chunkText(text) {
    const chunks = [];
    let currentChunk = '';
    const sentences = text.split(/([.!?])\s*/); // 문장 단위 분할
    for (let sentence of sentences) {
        if (currentChunk.length + sentence.length > CHUNK_SIZE_LIMIT) {
            chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

async function handleFiles(e) {
    const files = e.target.files;
    if (files.length + filesData.length > MAX_FILES) {
        alert(`파일은 최대 ${MAX_FILES}개까지 첨부 가능합니다.`);
        return;
    }

    for (let file of files) {
        const ext = file.name.toLowerCase().match(/\.( [^.]+$)/)?.[0] || '';
        if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const isImage = IMAGE_EXTENSIONS.includes(ext);
        filesData.push({
            id: fileId,
            name: file.name,
            fullText: '',
            fileObject: isImage ? file : null,
            isImage,
            chunks: [],
            isProcessed: false,
            isOcrProcessing: false
        });
    }

    requestAnimationFrame(renderFileList);
    if (filesData.length > 0 && currentFileIndex === -1) {
        currentFileIndex = 0;
    }
    requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    saveBookmark();
}

function setupFullScreenDragAndDrop() {
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        $fullScreenDropArea.style.display = 'flex';
    });

    document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (e.relatedTarget === null) {
            $fullScreenDropArea.style.display = 'none';
        }
    });

    document.addEventListener('drop', (e) => {
        e.preventDefault();
        $fullScreenDropArea.style.display = 'none';
        const files = e.dataTransfer.files;
        handleFiles({ target: { files } });
    });
}

async function processFile(fileIndex, autoPlay = false) {
    const file = filesData[fileIndex];
    if (file.isProcessed) return;

    if (file.isImage) {
        await processOcrForImage(fileIndex, autoPlay);
    } else {
        // 텍스트 파일 처리
        let text = '';
        const encodings = ['utf-8', 'euc-kr', 'iso-8859-1'];
        for (let encoding of encodings) {
            try {
                text = await readTextFile(file.fileObject, encoding);
                if (text.includes('?') || text.length === 0) continue;
                break;
            } catch (e) {
                console.warn(`인코딩 ${encoding} 실패: ${e}`);
            }
        }
        file.fullText = text.trim();
        file.chunks = chunkText(file.fullText);
        file.isProcessed = true;
        requestAnimationFrame(() => renderTextViewer(fileIndex));
        requestAnimationFrame(renderFileList);
        if (autoPlay) {
            startReadingFromCurrentChunk();
        }
    }
}

// --- OCR 처리 함수 (수정: DataCloneError 해결을 위해 HTMLImageElement 사용) ---
async function processOcrForImage(fileIndex, autoPlay = false) {
    const file = filesData[fileIndex];
    file.isOcrProcessing = true;
    requestAnimationFrame(() => renderTextViewer(fileIndex));
    requestAnimationFrame(renderFileList);

    const imageUrl = URL.createObjectURL(file.fileObject);
    try {
        // HTMLImageElement 생성 및 로드
        const image = new Image();
        image.src = imageUrl;
        await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
        });

        const worker = await Tesseract.createWorker('kor', 1, {
            logger: m => {
                console.log(m);
                if (m.status === 'recognizing text') {
                    const progress = m.progress || 0;
                    $textViewer.innerHTML = `<p style="color:#FFD700;">OCR 진행 중: ${(progress * 100).toFixed(2)}%</p>`;
                }
            },
        });

        const { data: { text } } = await worker.recognize(image);
        await worker.terminate();

        file.fullText = text.trim();
        file.chunks = chunkText(file.fullText);
        file.isProcessed = true;
        file.isOcrProcessing = false;

        requestAnimationFrame(() => renderTextViewer(fileIndex));
        requestAnimationFrame(renderFileList);

        if (autoPlay) {
            startReadingFromCurrentChunk();
        }
    } catch (e) {
        console.error('OCR 오류:', e);
        file.isOcrProcessing = false;
        $textViewer.innerHTML = `<p style="color:red;">OCR 처리 중 오류가 발생했습니다: ${e.message}</p>`;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

// 나머지 코드 (기존과 동일, 위에서 수정된 부분 적용)
function clearInitialTextViewerContent() {
    const currentText = $textViewer.textContent.trim().replace(/\s+/g, ' ');
    const initialText = INITIAL_TEXT_VIEWER_TEXT.trim().replace(/\s+/g, ' ');

    if (currentText === initialText || currentText === '') {
        $textViewer.innerHTML = '';
    }
}

async function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
        if (isSpeaking && !isPaused) {
            if (isMobile) {
                synth.cancel(); // 모바일에서 pause 대신 cancel
            } else {
                synth.pause();
            }
            isPaused = true;
            console.log('화면 잠금: 재생 일시정지');
        }
    } else if (document.visibilityState === 'visible' && isSpeaking && isPaused) {
        if (isMobile) {
            speakNextChunk(); // 모바일에서 resume 대신 재시작
        } else {
            synth.resume();
        }
        isPaused = false;
        console.log('화면 복귀: 재생 재개');
        if (isSpeaking) {
            await requestWakeLock();
        }
    }
}

window.addEventListener('beforeunload', () => {
    saveBookmark();
    if (synth.speaking) {
        synth.cancel();
    }
    releaseWakeLock();
});

// --- Wake Lock API 및 NoSleep.js ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock released.');
            });
            console.log('Wake Lock requested.');
        } catch (err) {
            console.warn(`Wake Lock request failed: ${err.name}, ${err.message}`);
            if (typeof NoSleep !== 'undefined') {
                noSleep = new NoSleep();
                noSleep.enable();
                console.log('NoSleep enabled for screen wake.');
            }
        }
    } else if (typeof NoSleep !== 'undefined') {
        noSleep = new NoSleep();
        noSleep.enable();
        console.log('NoSleep enabled for screen wake.');
    } else {
        console.warn('Wake Lock API and NoSleep.js are not supported.');
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().then(() => {
            wakeLock = null;
            console.log('Wake Lock released successfully.');
        }).catch((err) => {
            console.error(`Wake Lock release failed: ${err.name}, ${err.message}`);
        });
    }
    if (noSleep) {
        noSleep.disable();
        noSleep = null;
        console.log('NoSleep disabled.');
    }
}

function updateRateDisplay() {
    $rateDisplay.textContent = $rateSlider.value;
}

function readTextFile(file, encoding) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            resolve(e.target.result);
        };
        reader.onerror = (e) => {
            reject(new Error(`파일 읽기 오류 (${encoding}): ${e.target.error.name}`));
        };
        reader.readAsText(file, encoding);
    });
}

async function fetchAndProcessUrlContent(url) {
    if (!url) return;
    // URL 처리를 위해 프록시 사용 (CORS 회피)
    const PROXY_URL = 'https://api.allorigins.win/raw?url=';
    const targetUrl = PROXY_URL + encodeURIComponent(url);
    try {
        $textViewer.innerHTML = '웹페이지 콘텐츠를 불러오는 중입니다...';
        stopReading();
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error(`HTTP 오류: ${response.status}`);
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        
        // --- 🔍 1단계: 초기 정리 (Noise Filtering) ---
        const selectorsToRemove = 'script, style, link, header, footer, nav, aside, iframe, noscript, .ad, .advertisement, #comments, .sidebar, .comment-area, .pagination, .page-numbers, .related-posts, .breadcrumbs, .meta-data, .footer';
        doc.querySelectorAll(selectorsToRemove).forEach(el => el.remove());
        
        // 2. 본문 후보 요소들 선택 (넓은 범위 확장)
        const contentCandidates = Array.from(doc.querySelectorAll('article, main, .post, .entry, .article-body, .content, .read-content, #container, #wrap, #content, [role="main"], #novel_content, #bo_v_con, .chapter-content, .viewer, .contents, .article-main, .post-body')); 
        
        // 3. 텍스트 추출 및 정리 함수
        const cleanText = (element) => {
            if (!element) return '';
            let currentText = element.textContent.trim();
            // 불필요한 공백/줄바꿈 정리
            currentText = currentText.replace(/(\n\s*){3,}/g, '\n\n'); // 3개 이상의 연속 줄바꿈을 2개로 압축
            currentText = currentText.replace(/\t/g, ' '); // 탭 제거
            currentText = currentText.replace(/\s{2,}/g, ' '); // 연속된 공백 하나로
            return currentText;
        };

        let bestText = ''; 
        let maxTextLength = 0;
        
        // 4. 최적의 본문 요소 찾기
        for (const candidate of contentCandidates) {
            const candidateText = cleanText(candidate);
            if (candidateText.length > maxTextLength) {
                maxTextLength = candidateText.length;
                bestText = candidateText;
            }
        }
        
        let text = bestText.trim();
        
        // 5. 🚀 Fallback 로직 강화 (가장 강력한 수집 모드)
        if (text.length < 50) { 
            console.warn("Heuristic 추출 실패. 강력한 <p> 태그 수집 Fallback 실행.");
            
            // 본문 요소가 아닌, HTML 전체에서 <p> 태그의 텍스트만 추출
            const pTags = Array.from(doc.querySelectorAll('p'));
            let fallbackText = pTags.map(p => p.textContent.trim()).join('\n\n');
            fallbackText = fallbackText.replace(/(\n\s*){3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
            
            // 만약 Heuristic 추출된 텍스트(text)가 너무 짧고, Fallback 텍스트가 충분히 길다면 사용
            if (fallbackText.length > text.length * 0.8 && fallbackText.length > 50) {
                 text = fallbackText;
            } else if (text.length < 50) {
                 // 최종적으로 body 전체 텍스트를 정리해서 사용
                 text = cleanText(doc.body);
            }
        }
        
        if (text.length < 50) {
             throw new Error("URL에서 추출된 텍스트 내용이 너무 짧거나 콘텐츠를 찾을 수 없습니다. (추출된 문자열 길이: " + text.length + ")");
        }

        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const fileName = `[URL] ${url.substring(0, 50).replace(/[\\/?:<>\\*\\"] /g, '')}...`;
        filesData.push({
            id: fileId,
            name: fileName,
            fullText: text,
            isImage: false,
            chunks: chunkText(text),
            isProcessed: true,
            isOcrProcessing: false
        });
        currentFileIndex = filesData.length - 1;
        requestAnimationFrame(renderFileList);
        requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    } catch (e) {
        console.error(e);
        $textViewer.innerHTML = '<p style="color:red;">URL 콘텐츠 추출 실패: ' + e.message + '</p>';
    }
}

function handlePasteInTextViewer(e) {
    e.preventDefault();
    const files = e.clipboardData.files;
    const validFiles = Array.from(files).filter(f => {
        const ext = f.name.toLowerCase().match(/\.( [^.]+$)/)?.[0] || '';
        return ALLOWED_EXTENSIONS.includes(ext);
    });

    if (validFiles.length > 0) {
        handleFiles({ target: { files: validFiles, value: '' } });
        return;
    }

    // 텍스트나 파일이 없으면 안내 문구 다시 표시
    if (filesData.length === 0) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
    }
}

async function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1) return;

    const file = filesData[currentFileIndex];
    
    // 처리되지 않은 파일이면 OCR 또는 청크 처리를 시작합니다.
    if (!file.isProcessed) {
        // 이미 OCR 작업 중이면 대기
        if (file.isImage && file.isOcrProcessing) {
             console.log("OCR 작업 중이므로 대기합니다.");
             return;
        }
        
        await processFile(currentFileIndex, true);
        return; // processFile이 성공하면 재귀적으로 startReadingFromCurrentChunk를 호출합니다.
    }

    currentChunkIndex = Math.min(currentChunkIndex, file.chunks.length - 1);
    currentCharIndex = 0; // 위치 초기화
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    synth.cancel();
    await requestWakeLock();
    requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    speakNextChunk();
}

function speakNextChunk() {
    const file = filesData[currentFileIndex];
    if (!isSpeaking || isPaused) return;

    if (currentChunkIndex >= file.chunks.length) {
        if (isSequential) {
            changeFile(currentFileIndex + 1);
        } else {
            stopReading();
        }
        return;
    }

    let textToSpeak = file.chunks[currentChunkIndex].slice(currentCharIndex);
    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    currentUtterance.rate = parseFloat($rateSlider.value);
    currentUtterance.pitch = 1;

    currentUtterance.onend = () => {
        currentCharIndex = 0;
        currentChunkIndex++;
        saveBookmark();
        requestAnimationFrame(() => renderTextViewer(currentFileIndex));
        speakNextChunk();
    };

    currentUtterance.onboundary = (event) => {
        if (event.name === 'word') {
            currentCharIndex = event.charIndex;
        }
    };

    synth.speak(currentUtterance);
}

function togglePlayPause() {
    if (currentFileIndex === -1) {
        alert("재생할 파일 또는 텍스트를 먼저 준비해주세요.");
        return;
    }
    
    // 파일이 이미지이고 OCR이 완료되지 않은 경우 OCR 시작
    const file = filesData[currentFileIndex];
    if (file.isImage && !file.isProcessed) {
        processFile(currentFileIndex, true);
        return;
    }


    if (isSpeaking && !isPaused) {
        if (isMobile) {
            synth.cancel(); 
        } else {
            synth.pause();
        }
        isPaused = true;
        $playPauseBtn.textContent = '▶️';
        releaseWakeLock();
    } else if (isSpeaking && isPaused) {
        if (isMobile) {
            speakNextChunk(); 
        } else {
            synth.resume();
        }
        isPaused = false;
        $playPauseBtn.textContent = '⏸️';
        requestWakeLock();
    } else {
        // 최초 재생 시작 또는 파일 처리 시작
        startReadingFromCurrentChunk();
    }
}

function stopReading() {
    synth.cancel();
    isSpeaking = false;
    isPaused = false;
    currentChunkIndex = 0;
    currentCharIndex = 0;
    $playPauseBtn.textContent = '▶️';
    releaseWakeLock();
    if (currentFileIndex !== -1) {
        requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    }
}

function changeFile(newIndex) {
    if (newIndex < 0 || newIndex >= filesData.length) {
        alert("더 이상 읽을 파일이 없습니다.");
        stopReading();
        currentFileIndex = -1;
        requestAnimationFrame(() => renderTextViewer(-1));
        return;
    }

    synth.cancel();
    currentFileIndex = newIndex;
    currentChunkIndex = 0;
    currentCharIndex = 0;

    if (!filesData[newIndex].isProcessed) {
        processFile(newIndex, isSpeaking); // 현재 재생 상태를 유지하며 다음 파일 처리
    } else {
        requestAnimationFrame(() => renderTextViewer(newIndex));
        if (isSpeaking) {
            startReadingFromCurrentChunk();
        }
    }
}

// --- 파일 목록 관리 기능 ---
function handleFileListItemClick(e) {
    const li = e.target.closest('li');
    if (!li) return;

    const fileId = parseInt(li.dataset.fileId);
    const fileIndex = filesData.findIndex(f => f.id === fileId);
    if (fileIndex === -1) return;

    if (e.target.classList.contains('delete-file-btn')) {
        e.stopPropagation();
        deleteFile(fileIndex);
        return;
    }

    if (e.target.classList.contains('drag-handle')) {
        return;
    }

    if (isSpeaking || isPaused) {
        stopReading();
    }

    currentFileIndex = fileIndex;
    currentChunkIndex = 0;
    currentCharIndex = 0;

    // 파일을 클릭하면 바로 처리 및 재생 시작 (OCR 필요 시 OCR 시작)
    processFile(currentFileIndex, true); 

    requestAnimationFrame(renderFileList);
}

function deleteFile(index) {
    if (index === -1) return;

    const wasCurrentFile = index === currentFileIndex;
    filesData.splice(index, 1);

    if (wasCurrentFile) {
        stopReading();
        currentFileIndex = filesData.length > 0 ? 0 : -1;
        currentChunkIndex = 0;
        currentCharIndex = 0;
        requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    } else if (index < currentFileIndex) {
        currentFileIndex--;
    }

    requestAnimationFrame(renderFileList);
    saveBookmark();

    if (filesData.length === 0) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        currentFileIndex = -1;
    }
}

function clearAllFiles() {
    if (filesData.length === 0) return;
    if (!confirm("첨부된 파일 전체를 삭제하시겠습니까?")) return;

    stopReading();
    filesData = [];
    currentFileIndex = -1;
    currentChunkIndex = 0;
    currentCharIndex = 0;
    localStorage.removeItem('autumnReaderBookmark');
    requestAnimationFrame(renderFileList);
    $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
}

function setupFileListSortable() {
    if (typeof Sortable === 'undefined') {
        return;
    }

    new Sortable($fileList, {
        handle: '.drag-handle',
        animation: 150,
        onEnd: function (evt) {
            const oldIndex = evt.oldIndex;
            const newIndex = evt.newIndex;
            const [movedItem] = filesData.splice(oldIndex, 1);
            filesData.splice(newIndex, 0, movedItem);

            if (currentFileIndex === oldIndex) {
                currentFileIndex = newIndex;
            } else if (oldIndex < currentFileIndex && newIndex >= currentFileIndex) {
                currentFileIndex--;
            } else if (oldIndex > currentFileIndex && newIndex <= currentFileIndex) {
                currentFileIndex++;
            }

            requestAnimationFrame(renderFileList);
            saveBookmark();
        },
    });
}

// --- UI 및 북마크 기능 ---
function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        return;
    }

    const file = filesData[fileIndex];
    if (!file.isProcessed) {
        let statusMessage = `[파일 로딩 중/청크 처리 중] : ${file.name}`;
        if (file.isImage) {
            if (file.isOcrProcessing) {
                statusMessage = `[이미지 OCR 처리 중] : ${file.name} - 잠시만 기다려주세요... (Tesseract.js)`;
            } else {
                statusMessage = `[이미지 파일] : ${file.name} - 재생 버튼(▶️) 또는 파일 클릭 시 텍스트 인식(OCR)을 시작합니다.`;
            }
        }
        $textViewer.innerHTML = `<p style="color:#FFD700;">${statusMessage}</p>`;
        return;
    }

    const startIndex = Math.max(0, currentChunkIndex - Math.floor(VISIBLE_CHUNKS / 2));
    const endIndex = Math.min(file.chunks.length, startIndex + VISIBLE_CHUNKS);
    let htmlContent = '';

    for (let i = startIndex; i < endIndex; i++) {
        let chunkHtml = file.chunks[i].replace(/\n/g, '<br>');
        const isCurrentChunk = i === currentChunkIndex && (isSpeaking || isPaused);
        htmlContent += `<span class="text-chunk ${isCurrentChunk ? 'highlight' : ''}" data-index="${i}">${chunkHtml}</span>`;
    }

    $textViewer.innerHTML = htmlContent;

    if (isSpeaking || isPaused) {
        setTimeout(scrollToCurrentChunk, 100);
    }
}

function scrollToCurrentChunk() {
    const highlighted = $('.highlight');
    if (highlighted) {
        highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function setupTextViewerClickEvent() {
    $textViewer.addEventListener('click', (e) => {
        if (filesData.length === 0) return;

        const chunkElement = e.target.closest('.text-chunk');
        if (!chunkElement) return;

        if (chunkElement.classList.contains('highlight')) {
            return;
        }

        const newChunkIndex = parseInt(chunkElement.dataset.index);
        if (isNaN(newChunkIndex)) return;

        jumpToChunk(newChunkIndex);
    });
}

function jumpToChunk(index) {
    if (currentFileIndex === -1 || index >= filesData[currentFileIndex].chunks.length) return;

    synth.cancel();
    currentChunkIndex = index;
    currentCharIndex = 0;
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    requestAnimationFrame(() => renderTextViewer(currentFileIndex));
    requestWakeLock();
    speakNextChunk();
}

function renderFileList() {
    $fileList.innerHTML = '';
    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.fileId = file.id;

        const fileNameSpan = document.createElement('span');
        fileNameSpan.textContent = file.name;
        fileNameSpan.classList.add('file-item-name');

        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('file-controls');

        const dragHandle = document.createElement('button');
        dragHandle.innerHTML = '☰';
        dragHandle.classList.add('drag-handle');
        dragHandle.title = '순서 변경';

        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = 'X';
        deleteBtn.classList.add('delete-file-btn');
        deleteBtn.title = '파일 삭제';

        // OCR/처리 상태 표시
        if (!file.isProcessed) {
            let statusText = ' (⏳ 대기)';
            if (file.isImage) {
                if (file.isOcrProcessing) {
                    statusText = ' (⚙️ OCR 중...)';
                } else {
                    statusText = ' (🖼️ 이미지 대기)';
                }
            }
            const statusSpan = document.createElement('span');
            statusSpan.textContent = statusText;
            statusSpan.style.color = '#FFD700';
            fileNameSpan.appendChild(statusSpan);
        }

        controlsDiv.appendChild(dragHandle);
        controlsDiv.appendChild(deleteBtn);

        li.appendChild(fileNameSpan);
        li.appendChild(controlsDiv);

        li.classList.toggle('active', index === currentFileIndex);

        $fileList.appendChild(li);
    });
}

function saveBookmark() {
    if (currentFileIndex === -1) return;

    const bookmarkData = {
        fileId: filesData[currentFileIndex].id,
        fileName: filesData[currentFileIndex].name,
        chunkIndex: currentChunkIndex,
        isSequential: isSequential,
        settings: {
            voice: $voiceSelect.value,
            rate: $rateSlider.value
        }
    };
    localStorage.setItem('autumnReaderBookmark', JSON.stringify(bookmarkData));
}

function loadBookmark() {
    const data = localStorage.getItem('autumnReaderBookmark');
    if (!data) return;

    const bookmark = JSON.parse(data);
    if (bookmark.settings) {
        $rateSlider.value = bookmark.settings.rate;
        updateRateDisplay();
    }

    isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    if ($sequentialReadCheckbox) {
        $sequentialReadCheckbox.checked = isSequential;
    }
}