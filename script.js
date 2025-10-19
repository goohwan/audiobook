// --- 전역 변수 설정 ---
const MAX_FILES = 50;
const CHUNK_SIZE_LIMIT = 500;
const VISIBLE_CHUNKS = 10;
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i;
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif'];

let filesData = [];
let currentFileIndex = -1;
let currentChunkIndex = 0;
let currentCharIndex = 0;
let isSequential = true;
let wakeLock = null;
let noSleep = null;

const synth = window.speechSynthesis;
let currentUtterance = null;
let isPaused = false;
let isSpeaking = false;
let isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

const $ = (selector) => document.querySelector(selector);
const $fileInput = $('#file-input');
const $fullScreenDropArea = $('#full-screen-drop-area');
const $fileList = $('#file-list');
const $textViewer = $('#text-viewer');
const $voiceSelect = $('#voice-select');
const $rateSlider = $('#rate-slider');
const $rateDisplay = $('#rate-display');
const $playPauseBtn = $('#play-pause-btn');
const $sequentialReadCheckbox = $('#sequential-read-checkbox');
const $clearAllFilesBtn = $('#clear-all-files-btn');
const $webPageUrl = $('#web-page-url');
const $loadWebPageBtn = $('#load-web-page');

const INITIAL_TEXT_VIEWER_TEXT = '텍스트를 여기에 붙여넣거나(Ctrl+V 또는 Command+V) 파일을 화면에 드래그하여 업로드하세요.';
const INITIAL_TEXT_VIEWER_CONTENT = `<p>${INITIAL_TEXT_VIEWER_TEXT}</p>`;

// --- 초기화 ---
document.addEventListener('DOMContentLoaded', () => {
    if (!('speechSynthesis' in window)) {
        alert('Web Speech API를 지원하지 않는 브라우저입니다.');
        return;
    }

    if (synth.getVoices().length > 0) {
        populateVoiceList();
    }
    synth.onvoiceschanged = populateVoiceList;

    $fileInput.addEventListener('change', handleFiles);
    setupFullScreenDragAndDrop();

    $('#play-pause-btn').addEventListener('click', togglePlayPause);
    $('#stop-btn').addEventListener('click', stopReading);
    $('#next-file-btn').addEventListener('click', () => changeFile(currentFileIndex + 1));
    $('#prev-file-btn').addEventListener('click', () => changeFile(currentFileIndex - 1));

    $rateSlider.addEventListener('input', updateRateDisplay);
    $rateSlider.addEventListener('change', () => saveBookmark());

    loadBookmark();

    setupTextViewerClickEvent();
    $textViewer.addEventListener('paste', handlePasteInTextViewer);
    $textViewer.addEventListener('focus', clearInitialTextViewerContent);

    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
        saveBookmark();
    });

    $clearAllFilesBtn.addEventListener('click', clearAllFiles);
    $fileList.addEventListener('click', handleFileListItemClick);

    setupFileListSortable();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    $loadWebPageBtn.addEventListener('click', loadWebPageImages);
});

// --- 유틸리티 함수 ---
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
                synth.cancel();
            } else {
                synth.pause();
            }
            isPaused = true;
        }
    } else if (document.visibilityState === 'visible' && isSpeaking && isPaused) {
        if (isMobile) {
            speakNextChunk();
        } else {
            synth.resume();
        }
        isPaused = false;
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

// --- Wake Lock ---
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            if (typeof NoSleep !== 'undefined') {
                noSleep = new NoSleep();
                noSleep.enable();
            }
        }
    } else if (typeof NoSleep !== 'undefined') {
        noSleep = new NoSleep();
        noSleep.enable();
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
    if (noSleep) {
        noSleep.disable();
        noSleep = null;
    }
}

// --- 목소리 설정 ---
function populateVoiceList() {
    const voices = synth.getVoices();
    $voiceSelect.innerHTML = '';

    let koreanVoices = [];
    voices.forEach((voice) => {
        if (voice.lang.includes('ko')) {
            const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
            koreanVoices.push(option);
        }
    });

    koreanVoices.forEach(option => $voiceSelect.appendChild(option));

    const savedBookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));
    if (savedBookmark && savedBookmark.settings && $voiceSelect.querySelector(`option[value="${savedBookmark.settings.voice}"]`)) {
        $voiceSelect.value = savedBookmark.settings.voice;
    } else if (koreanVoices.length > 0) {
        $voiceSelect.value = koreanVoices[0].value;
    }

    if (savedBookmark && savedBookmark.settings) {
        $rateSlider.value = savedBookmark.settings.rate;
    }
    updateRateDisplay();
}

function updateRateDisplay() {
    $rateDisplay.textContent = $rateSlider.value;
}

// --- 파일 처리 및 인코딩 변환 ---
function readTextFile(file, encoding) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            let content = e.target.result;
            // UTF-8이 아닌 경우 변환 시도
            if (encoding !== 'UTF-8') {
                try {
                    const decoder = new TextDecoder(encoding);
                    content = decoder.decode(new Uint8Array(e.target.result));
                } catch {
                    content = new TextDecoder('UTF-8').decode(new Uint8Array(e.target.result));
                    console.log(`파일 "${file.name}"의 인코딩을 UTF-8로 변환했습니다.`);
                }
            }
            resolve(content);
        };
        reader.onerror = (e) => reject(new Error(`파일 읽기 오류: ${e.target.error.name}`));
        reader.readAsArrayBuffer(file); // ArrayBuffer로 읽어 인코딩 확인 가능
    });
}

async function processImageOCR(fileOrUrl) {
    const worker = await Tesseract.createWorker('kor');
    try {
        let imageSource;
        if (typeof fileOrUrl === 'string') {
            imageSource = fileOrUrl;
        } else {
            imageSource = URL.createObjectURL(fileOrUrl);
        }
        const { data: { text } } = await worker.recognize(imageSource);
        return text.trim();
    } catch (error) {
        console.error('OCR 오류:', error);
        return '';
    } finally {
        await worker.terminate();
    }
}

// --- URL 처리 (텍스트 추출) ---
async function fetchAndProcessUrlContent(url) {
    if (!url) return;
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
        
        // 노이즈 제거
        const selectorsToRemove = 'script, style, link, header, footer, nav, aside, iframe, noscript, .ad, .advertisement, #comments, .sidebar';
        doc.querySelectorAll(selectorsToRemove).forEach(el => el.remove());
        
        // 본문 추출
        const contentCandidates = Array.from(doc.querySelectorAll('article, main, .post, .entry, .content, #content'));
        let bestText = '';
        let maxTextLength = 0;
        
        const cleanText = (element) => {
            if (!element) return '';
            let text = element.textContent.trim();
            text = text.replace(/(\n\s*){3,}/g, '\n\n').replace(/\t/g, ' ').replace(/\s{2,}/g, ' ');
            return text;
        };
        
        for (const candidate of contentCandidates) {
            const candidateText = cleanText(candidate);
            if (candidateText.length > maxTextLength) {
                maxTextLength = candidateText.length;
                bestText = candidateText;
            }
        }
        
        let text = bestText.trim();
        
        // Fallback
        if (text.length < 50) {
            const pTags = Array.from(doc.querySelectorAll('p'));
            text = pTags.map(p => p.textContent.trim()).join('\n\n');
            text = text.replace(/(\n\s*){3,}/g, '\n\n').replace(/\s{2,}/g, ' ').trim();
        }
        
        if (text.length < 50) {
            throw new Error("콘텐츠를 찾을 수 없습니다.");
        }

        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const fileName = `[URL] ${url.substring(0, 50).replace(/(\/|\?)/g, ' ')}...`;
        const newFileData = {
            id: fileId,
            name: fileName,
            fullText: text,
            chunks: [],
            isProcessed: false
        };
        
        filesData.unshift(newFileData);
        if (filesData.length > MAX_FILES) filesData.pop();

        renderFileList();
        currentFileIndex = 0;
        processFileChunks(0, true);
        $textViewer.innerHTML = '';
        
    } catch (error) {
        alert(`URL 로드 실패: ${error.message}`);
        $textViewer.innerHTML = `<p style="color:red;">오류: ${error.message}</p>`;
    }
}

// --- 새 기능: 웹페이지 이미지 추출 및 OCR ---
async function loadWebPageImages() {
    const url = $webPageUrl.value.trim();
    if (!url || !URL_PATTERN.test(url)) {
        alert('유효한 URL을 입력해주세요.');
        return;
    }

    const PROXY_URL = 'https://api.allorigins.win/raw?url=';
    const targetUrl = PROXY_URL + encodeURIComponent(url);

    try {
        $textViewer.innerHTML = '웹페이지 이미지를 불러오는 중...';
        stopReading();

        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error(`HTTP 오류: ${response.status}`);

        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');

        // 모든 img 태그 추출
        const imgElements = Array.from(doc.querySelectorAll('img'));
        const imageUrls = [];

        // 각 이미지 로드하여 height 확인
        for (const img of imgElements) {
            const src = img.src;
            if (src && !src.startsWith('data:')) { // 데이터 URI 제외
                const height = await getImageHeight(src);
                console.log(`이미지 ${src} 높이: ${height}px`);
                if (height >= 650) {
                    imageUrls.push(src);
                }
            }
        }

        if (imageUrls.length === 0) {
            throw new Error('세로 650px 이상의 이미지를 찾을 수 없습니다.');
        }

        // OCR 처리
        $textViewer.innerHTML = '이미지 OCR 처리 중...';
        let combinedText = '';
        for (let i = 0; i < imageUrls.length; i++) {
            const imgUrl = imageUrls[i];
            console.log(`OCR 처리 중: ${imgUrl}`);
            const ocrText = await processImageOCR(imgUrl);
            if (ocrText) {
                combinedText += ocrText + '\n\n';
            }
            console.log(`OCR 결과 (${i + 1}/${imageUrls.length}): ${ocrText.substring(0, 50)}...`);
        }

        if (!combinedText.trim()) {
            throw new Error('OCR로 추출된 텍스트가 없습니다.');
        }

        // 파일 데이터 추가
        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const fileName = `[웹 이미지] ${url.substring(0, 50).replace(/(\/|\?)/g, ' ')}...`;
        const newFileData = {
            id: fileId,
            name: fileName,
            fullText: combinedText.trim(),
            chunks: [],
            isProcessed: false
        };

        filesData.unshift(newFileData);
        if (filesData.length > MAX_FILES) filesData.pop();

        renderFileList();
        currentFileIndex = 0;
        processFileChunks(0, true);
        $textViewer.innerHTML = '';

    } catch (error) {
        console.error('웹페이지 처리 오류:', error);
        alert(`웹페이지 처리 실패: ${error.message}`);
        $textViewer.innerHTML = `<p style="color:red;">오류: ${error.message}</p>`;
    }
}

function getImageHeight(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous'; // CORS 문제 완화 시도
        img.onload = () => resolve(img.height);
        img.onerror = () => resolve(0);
        img.src = url;
    });
}

// --- 붙여넣기 처리 ---
function processPastedText(text) {
    if (!text) return;

    const fileId = Date.now() + Math.floor(Math.random() * 1000000);
    const fileName = `[클립보드] ${new Date().toLocaleTimeString()} - ${text.substring(0, 20)}...`;

    const newFileData = {
        id: fileId,
        name: fileName,
        fullText: text,
        chunks: [],
        isProcessed: false
    };

    filesData.unshift(newFileData);
    if (filesData.length > MAX_FILES) filesData.pop();

    renderFileList();
    currentFileIndex = 0;
    processFileChunks(0, true);
    $textViewer.innerHTML = '';
}

function handlePasteInTextViewer(e) {
    clearInitialTextViewerContent();
    
    if (!isMobile) {
        e.preventDefault();
        const pasteData = (e.clipboardData || window.clipboardData).getData('text');
        const trimmedText = pasteData.trim();
        
        if (trimmedText) {
            if (URL_PATTERN.test(trimmedText)) {
                fetchAndProcessUrlContent(trimmedText);
            } else {
                processPastedText(trimmedText);
            }
        }
        return;
    } 
    
    setTimeout(() => {
        let extractedText = $textViewer.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
        $textViewer.innerHTML = '';

        if (extractedText && extractedText.replace(/\s+/g, ' ') !== INITIAL_TEXT_VIEWER_TEXT.replace(/\s+/g, ' ')) {
            if (URL_PATTERN.test(extractedText)) {
                fetchAndProcessUrlContent(extractedText);
            } else {
                processPastedText(extractedText);
            }
        } else {
            $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        }
    }, 250);
}

// --- 파일 업로드 처리 ---
async function handleFiles(event) {
    clearInitialTextViewerContent();
    
    const newFiles = Array.from(event.target.files).filter(file => {
        const lowerName = file.name.toLowerCase();
        return lowerName.endsWith('.txt') || IMAGE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
    });
    
    if (filesData.length + newFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부 가능합니다.`);
        newFiles.splice(MAX_FILES - filesData.length);
    }
    
    if (newFiles.length === 0) {
        event.target.value = '';
        return;
    }

    const filePromises = newFiles.map(async (file) => {
        const lowerName = file.name.toLowerCase();
        let content = '';
        
        if (lowerName.endsWith('.txt')) {
            try {
                content = await readTextFile(file, 'UTF-8');
                // UTF-8이 아닌 경우 확인 후 변환
                if (!isUTF8(content)) {
                    const decoder = new TextDecoder('windows-949');
                    content = decoder.decode(new Uint8Array(new TextEncoder().encode(content)));
                    console.log(`파일 "${file.name}"의 인코딩을 UTF-8로 변환했습니다.`);
                }
            } catch (error) {
                try {
                    content = await readTextFile(file, 'windows-949');
                    if (!isUTF8(content)) {
                        content = new TextDecoder('UTF-8').decode(new Uint8Array(new TextEncoder().encode(content)));
                        console.log(`파일 "${file.name}"의 인코딩을 UTF-8로 변환했습니다.`);
                    }
                } catch (error) {
                    alert(`파일 "${file.name}"을(를) 읽는 데 실패했습니다. 파일 인코딩을 확인해 주세요.`);
                    return null;
                }
            }
        } else {
            $textViewer.innerHTML = `<p style="color:#FFD700;">[OCR 처리 중] : ${file.name}</p>`;
            content = await processImageOCR(file);
            if (!content) {
                alert(`이미지 "${file.name}"에서 텍스트 추출 실패`);
                return null;
            }
        }

        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        return {
            id: fileId,
            name: file.name,
            fullText: content,
            chunks: [],
            isProcessed: false
        };
    });

    const results = await Promise.all(filePromises);
    const newlyReadFiles = results.filter(file => file !== null);
    
    if (newlyReadFiles.length === 0) {
        event.target.value = '';
        return;
    }

    newlyReadFiles.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    filesData.push(...newlyReadFiles);

    if (currentFileIndex === -1) {
        currentFileIndex = filesData.length - newlyReadFiles.length;
        processFileChunks(currentFileIndex, false);
    }

    renderFileList();
    event.target.value = '';
}

// UTF-8 여부 확인 (간단한 체크)
function isUTF8(str) {
    try {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder('utf-8');
        const encoded = encoder.encode(str);
        decoder.decode(encoded);
        return true;
    } catch (e) {
        return false;
    }
}

// --- 청크 처리 ---
function processFileChunks(fileIndex, startReading) {
    const file = filesData[fileIndex];
    if (!file || file.isProcessed) return;

    const text = file.fullText;
    const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
    let currentChunk = '';

    sentences.forEach(sentence => {
        if ((currentChunk + sentence).length > CHUNK_SIZE_LIMIT) {
            file.chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += sentence;
        }
    });

    if (currentChunk.trim()) {
        file.chunks.push(currentChunk.trim());
    }

    file.isProcessed = true;

    if (startReading && currentFileIndex === fileIndex) {
        renderTextViewer(fileIndex);
        startReadingFromCurrentChunk();
    }

    renderFileList();
}

// --- 드래그 앤 드롭 ---
function setupFullScreenDragAndDrop() {
    let dragCounter = 0;

    document.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) {
            $fullScreenDropArea.style.display = 'flex';
        }
    }, false);

    document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }, false);

    document.addEventListener('dragleave', (e) => {
        dragCounter--;
        if (dragCounter === 0) {
            $fullScreenDropArea.style.display = 'none';
        }
    }, false);

    $fullScreenDropArea.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        $fullScreenDropArea.style.display = 'none';

        const dt = e.dataTransfer;
        const droppedText = dt.getData('text/plain').trim();
        const files = dt.files;

        if (droppedText) {
            if (IMAGE_EXTENSIONS.some(ext => droppedText.toLowerCase().endsWith(ext))) {
                const ocrText = await processImageOCR(droppedText);
                if (ocrText) {
                    processPastedText(ocrText);
                } else {
                    alert('이미지에서 텍스트 추출 실패');
                }
            } else if (URL_PATTERN.test(droppedText)) {
                fetchAndProcessUrlContent(droppedText);
            } else {
                processPastedText(droppedText);
            }
            return;
        }

        if (files && files.length > 0) {
            handleFiles({ target: { files: files, value: '' } });
        }
    }, false);
}

// --- 재생 컨트롤 ---
async function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1) return;

    const file = filesData[currentFileIndex];
    if (!file || !file.isProcessed) {
        processFileChunks(currentFileIndex, true);
        return;
    }

    currentChunkIndex = Math.min(currentChunkIndex, file.chunks.length - 1);
    currentCharIndex = 0;
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    synth.cancel();
    await requestWakeLock();
    renderTextViewer(currentFileIndex);
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
        renderTextViewer(currentFileIndex);
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
        alert("재생할 파일을 선택해주세요.");
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
        renderTextViewer(currentFileIndex);
    }
}

function changeFile(newIndex) {
    if (newIndex < 0 || newIndex >= filesData.length) {
        alert("더 이상 읽을 파일이 없습니다.");
        stopReading();
        currentFileIndex = -1;
        renderTextViewer(-1);
        return;
    }

    synth.cancel();
    currentFileIndex = newIndex;
    currentChunkIndex = 0;
    currentCharIndex = 0;

    if (!filesData[newIndex].isProcessed) {
        processFileChunks(newIndex, true);
    } else {
        renderTextViewer(newIndex);
        if (isSpeaking) {
            startReadingFromCurrentChunk();
        }
    }
}

// --- 파일 목록 관리 ---
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

    if (!filesData[currentFileIndex].isProcessed) {
        processFileChunks(currentFileIndex, true);
    } else {
        startReadingFromCurrentChunk();
    }

    renderFileList();
    renderTextViewer(currentFileIndex);
}

function deleteFile(index) {
    const wasCurrentFile = index === currentFileIndex;
    filesData.splice(index, 1);

    if (wasCurrentFile) {
        stopReading();
        currentFileIndex = filesData.length > 0 ? 0 : -1;
        renderTextViewer(currentFileIndex);
    } else if (index < currentFileIndex) {
        currentFileIndex--;
    }

    renderFileList();
    saveBookmark();

    if (filesData.length === 0) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        currentFileIndex = -1;
    }
}

function clearAllFiles() {
    if (filesData.length === 0 || !confirm("전체 파일을 삭제하시겠습니까?")) return;

    stopReading();
    filesData = [];
    currentFileIndex = -1;
    localStorage.removeItem('autumnReaderBookmark');
    renderFileList();
    $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
}

function setupFileListSortable() {
    if (typeof Sortable === 'undefined') return;

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

            renderFileList();
            saveBookmark();
        },
    });
}

// --- UI 렌der링 ---
function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        return;
    }

    const file = filesData[fileIndex];
    if (!file.isProcessed) {
        $textViewer.innerHTML = `<p style="color:#FFD700;">[처리 중] : ${file.name}</p>`;
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
        if (!chunkElement || chunkElement.classList.contains('highlight')) return;

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

    renderTextViewer(currentFileIndex);
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

        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('file-controls');

        const dragHandle = document.createElement('button');
        dragHandle.innerHTML = '☰';
        dragHandle.classList.add('drag-handle');
        dragHandle.title = '순서 변경';

        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = 'X';
        deleteBtn.classList.add('delete-file-btn');
        deleteBtn.title = '삭제';

        if (!file.isProcessed) {
            const statusSpan = document.createElement('span');
            statusSpan.textContent = ' (⏳ 대기)';
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

// --- 북마크 ---
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
    $sequentialReadCheckbox.checked = isSequential;
}