// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i; // URL 인식 패턴

// --- 파일 관련 상수 추가 ---
const TEXT_EXTENSIONS = ['.txt', 'pdf'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.tif'];
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

// DOM 요소 선택 헬퍼
const $ = (selector) => document.querySelector(selector); 
let $fileInput, $fullScreenDropArea, $fileList, $textViewer, $voiceSelect, $rateSlider, $rateDisplay, $playPauseBtn;
let $sequentialReadCheckbox, $clearAllFilesBtn;

const INITIAL_TEXT_VIEWER_TEXT = '텍스트, 이미지 파일을 드래그하여 첨부하거나 텍스트/URL을 붙여넣어 오디오북으로 변환하세요! 모바일에선 파일첨부, 음성로드 버튼을 활용해주세요';
const INITIAL_TEXT_VIEWER_CONTENT = `<p>${INITIAL_TEXT_VIEWER_TEXT}</p>`;

// --- 초기화 ---
document.addEventListener('DOMContentLoaded', () => {
    // DOM 요소 할당
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

    $voiceSelect.addEventListener('change', () => {
        saveBookmark();
        if (isSpeaking) {
            synth.cancel();
            speakNextChunk();
        }
    });

    loadBookmark();

    setupTextViewerClickEvent();
    $textViewer.addEventListener('paste', handlePasteInTextViewer);
    $textViewer.addEventListener('focus', clearInitialTextViewerContent);
    $textViewer.addEventListener('focusout', restoreInitialTextViewerContent);

    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
        saveBookmark();
    });

    $clearAllFilesBtn.addEventListener('click', clearAllFiles);
    $fileList.addEventListener('click', handleFileListItemClick);

    setupFileListSortable();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // 모바일 전용 버튼 설정
    if (isMobile) {
        const $mobileFileUploadBtn = $('#mobile-file-upload-btn');
        const $mobileLoadVoiceBtn = $('#mobile-load-voice-btn');

        if ($mobileFileUploadBtn) {
            $mobileFileUploadBtn.addEventListener('click', () => {
                console.log('모바일 파일첨부 버튼 클릭'); // 디버깅용
                $fileInput.click();
            });
        }

        if ($mobileLoadVoiceBtn) {
            $mobileLoadVoiceBtn.addEventListener('click', () => {
                console.log('모바일 음성로드 버튼 클릭'); // 디버깅용
                const extractedText = $textViewer.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
                $textViewer.innerHTML = '';
                if (extractedText && extractedText.replace(/\s+/g, ' ') !== INITIAL_TEXT_VIEWER_TEXT.replace(/\s+/g, ' ')) {
                    console.log('처리된 텍스트:', extractedText); // 디버깅용
                    if (URL_PATTERN.test(extractedText)) {
                        fetchAndProcessUrlContent(extractedText);
                    } else {
                        processPastedText(extractedText);
                    }
                } else {
                    $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
                }
            });
        }
    }
});

// --- 유틸리티 함수 ---
function clearInitialTextViewerContent() {
    const currentText = $textViewer.textContent.trim().replace(/\s+/g, ' ');
    const initialText = INITIAL_TEXT_VIEWER_TEXT.trim().replace(/\s+/g, ' ');
    if (currentText === initialText || currentText === '') {
        $textViewer.innerHTML = '';
        $textViewer.setAttribute('data-placeholder', ''); // 포커싱 상태 표시
    }
}

function restoreInitialTextViewerContent() {
    const currentText = $textViewer.textContent.trim().replace(/\s+/g, ' ');
    if (currentText === '') {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        $textViewer.removeAttribute('data-placeholder'); // 포커스 아웃 상태 표시
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
    let preferredVoiceName = null;

    voices.forEach((voice) => {
        const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
        if (voice.lang.includes('ko')) {
            koreanVoices.push(option);
            if (voice.name.includes('Google') || voice.name.includes('Standard') || voice.name.includes('Wavenet')) {
                preferredVoiceName = voice.name;
            }
        }
    });

    koreanVoices.forEach(option => $voiceSelect.appendChild(option));

    const savedBookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));
    let selectedVoice = null;
    
    if (savedBookmark && savedBookmark.settings && $voiceSelect.querySelector(`option[value="${savedBookmark.settings.voice}"]`)) {
        selectedVoice = savedBookmark.settings.voice;
    } else if (preferredVoiceName) {
        selectedVoice = preferredVoiceName;
    } else if (koreanVoices.length > 0) {
        selectedVoice = koreanVoices[0].value;
    }

    if (selectedVoice) {
         $voiceSelect.value = selectedVoice;
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
            try {
                const decoder = new TextDecoder(encoding);
                const content = decoder.decode(e.target.result);
                resolve(content);
            } catch (error) {
                reject(new Error(`디코딩 오류 (${encoding}): ${error.message}`));
            }
        };
        reader.onerror = (e) => reject(new Error(`파일 읽기 오류: ${e.target.error.name}`));
        reader.readAsArrayBuffer(file);
    });
}

// --- OCR 처리 ---
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

// --- URL 처리 ---
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
        
        const selectorsToRemove = 'script, style, link, header, footer, nav, aside, iframe, noscript, .ad, .advertisement, #comments, .sidebar';
        doc.querySelectorAll(selectorsToRemove).forEach(el => el.remove());
        
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
            isProcessed: false,
            isImage: false,
            isOcrProcessing: false
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
        isProcessed: false,
        isImage: false,
        isOcrProcessing: false
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
    // 모바일 paste 시 버튼으로 처리
}

// --- 파일 업로드 처리 ---
async function handleFiles(event) {
    clearInitialTextViewerContent();
    
    const newFiles = Array.from(event.target.files).filter(file => {
        const lowerName = file.name.toLowerCase();
        return ALLOWED_EXTENSIONS.some(ext => lowerName.endsWith(ext));
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
        const isImageFile = IMAGE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
        let content = '';
        let fileObject = isImageFile ? file : null;

        if (!isImageFile) {
            try {
                content = await readTextFile(file, 'utf-8');
                if (!content || content.includes('\ufffd')) {
                    console.log(`파일 "${file.name}" UTF-8 읽기 실패. Windows-949로 재시도.`);
                    try {
                        content = await readTextFile(file, 'windows-949');
                        if (content.includes('\ufffd')) {
                            console.warn(`파일 "${file.name}"은(는) windows-949로도 완벽히 읽을 수 없습니다.`);
                        } else {
                            console.log(`파일 "${file.name}"을(를) windows-949로 성공적으로 읽었습니다.`);
                        }
                    } catch (error) {
                        console.error(`파일 "${file.name}" 인코딩 처리 최종 실패:`, error);
                        alert(`파일 "${file.name}"을(를) 읽는 데 실패했습니다. 파일 인코딩을 확인해 주세요.`);
                        return null;
                    }
                }
            } catch (error) {
                console.error(`파일 "${file.name}" 읽기 오류:`, error);
                alert(`파일 "${file.name}"을(를) 읽는 데 실패했습니다. 파일 형식을 확인해 주세요.`);
                return null;
            }
        }
        
        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        return {
            id: fileId,
            name: file.name,
            fullText: content || '',
            fileObject: fileObject,
            isImage: isImageFile,
            chunks: [],
            isProcessed: !isImageFile,
            isOcrProcessing: false
        };
    });

    const results = await Promise.all(filePromises);
    const newlyReadFiles = results.filter(file => file !== null);
    
    if (newlyReadFiles.length === 0) {
        event.target.value = '';
        return;
    }

    newlyReadFiles.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    
    const initialFilesCount = filesData.length;
    filesData.push(...newlyReadFiles);

    if (currentFileIndex === -1) {
        currentFileIndex = initialFilesCount;
    }

    const firstUnprocessedIndex = filesData.findIndex(f => !f.isProcessed);
    if (firstUnprocessedIndex !== -1) {
        processFile(firstUnprocessedIndex, true);
    } else if (currentFileIndex !== -1) {
        renderTextViewer(currentFileIndex);
    }
    renderFileList();
    event.target.value = '';
}

// --- 파일 처리 ---
async function processFile(fileIndex, startReading) {
    const file = filesData[fileIndex];
    if (!file || file.isProcessed || file.isOcrProcessing) return;

    if (file.isImage) {
        file.isOcrProcessing = true;
        renderFileList();
        if (fileIndex === currentFileIndex) {
            $textViewer.innerHTML = `<p style="color:#FFD700;">[OCR 처리 중] : ${file.name}</p>`;
        }
        
        try {
            const content = await processImageOCR(file.fileObject);
            if (!content) {
                alert(`이미지 "${file.name}"에서 텍스트 추출 실패`);
                file.fullText = `[OCR 실패] ${file.name} - 텍스트를 추출하지 못했습니다.`;
                file.isOcrProcessing = false;
                file.isProcessed = true;
                renderFileList();
                if (fileIndex === currentFileIndex) {
                    $textViewer.innerHTML = `<p style="color:red;">[OCR 실패] ${file.name} - 텍스트를 추출하지 못했습니다.</p>`;
                }
                return;
            }
            
            file.fullText = content;
            file.isOcrProcessing = false;
            file.isProcessed = true;
            console.log(`[OCR 완료] 파일 "${file.name}" OCR 처리 완료.`);
            
            processFileChunks(fileIndex, startReading);
            
            const nextUnprocessedIndex = filesData.findIndex((f, i) => !f.isProcessed && f.isImage && i > fileIndex);
            if (nextUnprocessedIndex !== -1) {
                processFile(nextUnprocessedIndex, false);
            }
        } catch (error) {
            console.error('파일 처리 중 오류:', error);
            alert(`파일 처리 중 오류 발생: ${file.name}`);
            file.isOcrProcessing = false;
            file.isProcessed = true;
            renderFileList();
        }
    } else if (!file.isImage) {
        file.isProcessed = true;
        processFileChunks(fileIndex, startReading);
    }
}

// --- 청크 처리 ---
function processFileChunks(fileIndex, startReading) {
    const file = filesData[fileIndex];
    if (!file || !file.isProcessed) return;

    if (file.chunks.length > 0 && file.chunks[0] !== '') {
        if (startReading && currentFileIndex === fileIndex) {
            renderTextViewer(fileIndex);
            startReadingFromCurrentChunk();
        }
        renderFileList();
        return;
    }

    const text = file.fullText || '';
    if (!text) {
        file.isProcessed = true;
        file.chunks = [''];
        console.warn(`파일 "${file.name}"의 텍스트가 비어 있습니다.`);
        if (startReading && currentFileIndex === fileIndex) {
            renderTextViewer(fileIndex);
            startReadingFromCurrentChunk();
        }
        renderFileList();
        return;
    }

    const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^\s]+/g) || [text];
    let currentChunk = '';
    file.chunks = [];

    sentences.forEach((sentence) => {
        if (!sentence) return;

        const newChunk = currentChunk + sentence;
        if (newChunk.length > CHUNK_SIZE_LIMIT) {
            if (currentChunk) {
                file.chunks.push(currentChunk.trim());
            }
            currentChunk = sentence;
        } else {
            currentChunk = newChunk;
        }
    });

    if (currentChunk.trim()) {
        file.chunks.push(currentChunk.trim());
    }

    if (file.chunks.length === 0 && text.length > 0) {
        file.chunks.push(text);
    }

    file.isProcessed = true;
    console.log(`[처리 완료] 파일 "${file.name}" 청크 처리 완료. 총 ${file.chunks.length}개 청크.`);

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
            if (URL_PATTERN.test(droppedText)) {
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
    if (currentFileIndex === -1 || !filesData[currentFileIndex]) return;

    const file = filesData[currentFileIndex];
    if (!file.isProcessed) {
        processFile(currentFileIndex, true);
        return;
    }

    if (file.chunks.length === 0) {
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
    if (!isSpeaking || isPaused || !file || !file.chunks || file.chunks.length === 0) return;

    if (currentChunkIndex >= file.chunks.length) {
        if (isSequential) {
            changeFile(currentFileIndex + 1);
        } else {
            stopReading();
        }
        return;
    }

    let textToSpeak = file.chunks[currentChunkIndex].slice(currentCharIndex);
    if (!textToSpeak) {
        currentCharIndex = 0;
        currentChunkIndex++;
        speakNextChunk();
        return;
    }

    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value) || synth.getVoices()[0];
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

    try {
        synth.speak(currentUtterance);
    } catch (error) {
        console.error('음성 합성 오류:', error);
        alert('음성 재생 중 오류가 발생했습니다. 브라우저 설정을 확인해 주세요.');
        stopReading();
    }
}

function togglePlayPause() {
    if (currentFileIndex === -1) {
        alert("재생할 파일을 선택해 주세요.");
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
        console.log('wake lock 해제');
    } else if (isSpeaking && isPaused) {
        if (isMobile) {
            speakNextChunk();
        } else {
            synth.resume();
        }
        isPaused = false;
        $playPauseBtn.textContent = '⏸️';
        requestWakeLock();
        console.log('wake lock 가동');
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
        renderFileList();
        return;
    }

    synth.cancel();
    currentFileIndex = newIndex;
    currentChunkIndex = 0;
    currentCharIndex = 0;

    if (!filesData[newIndex].isProcessed) {
        processFile(newIndex, isSpeaking);
    } else {
        renderTextViewer(newIndex);
        if (isSpeaking) {
            startReadingFromCurrentChunk();
        }
    }
    renderFileList();
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
        processFile(currentFileIndex, true);
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

// --- UI 렌더링 ---
function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) {
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
        return;
    }

    const file = filesData[fileIndex];

    if (file.isImage && file.isOcrProcessing) {
        $textViewer.innerHTML = `<p style="color:#FFD700;">[OCR 처리 중] : ${file.name}</p>`;
        return;
    }
    
    if (!file.isProcessed) {
        $textViewer.innerHTML = `<p style="color:#FFD700;">[처리 대기 중] : ${file.name}</p>`;
        return;
    }
    
    if (file.fullText.startsWith('[OCR 실패]')) {
        $textViewer.innerHTML = `<p style="color:red;">${file.fullText}</p>`;
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
            let statusText = ' (⏳ 대기)';
            if (file.isImage) {
                if (file.isOcrProcessing) {
                    statusText = ' (OCR 처리 중)';
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
    if ($sequentialReadCheckbox) {
        $sequentialReadCheckbox.checked = isSequential;
    }
}