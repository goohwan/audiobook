// --- 전역 변수 설정 ---
const MAX_FILES = 20;
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수 (Web Speech API 안정성 고려)
const PRELOAD_CHUNK_COUNT = 10; // 초기 재생을 위해 미리 분할할 텍스트 청크 수

let filesData = []; // 업로드된 모든 파일의 데이터 저장 ({ id, name, fullText, chunks, isProcessed })
let currentFileIndex = -1;
let currentChunkIndex = 0;

// Web Speech API 객체
const synth = window.speechSynthesis;
let currentUtterance = null; // 현재 발화 중인 SpeechSynthesisUtterance 객체
let isPaused = false;
let isSpeaking = false;

// DOM 요소 캐시
const $ = (selector) => document.querySelector(selector);
const $fileInput = $('#file-input');
const $dropArea = $('#drop-area');
const $fileList = $('#file-list');
const $textViewer = $('#text-viewer');
const $voiceSelect = $('#voice-select');
const $rateSlider = $('#rate-slider');
const $rateDisplay = $('#rate-display');
const $playPauseBtn = $('#play-pause-btn');

// --- 클립보드 관련 DOM 요소
const $clipboardTextInput = $('#clipboard-text-input');
const $loadClipboardBtn = $('#load-clipboard-btn');

// --- URL 관련 DOM 요소 추가
const $urlTextInput = $('#url-text-input');
const $loadUrlBtn = $('#load-url-btn');
// ----------------------------------------

// --- 초기화 및 이벤트 리스너 ---

document.addEventListener('DOMContentLoaded', () => {
    if (!('speechSynthesis' in window)) {
        alert('죄송합니다. 이 브라우저는 Web Speech API를 지원하지 않아 서비스를 이용할 수 없습니다.');
        return;
    }

    // 1. 목소리 목록 로드 및 설정 UI 초기화
    if (synth.getVoices().length > 0) {
        populateVoiceList(); 
    }
    synth.onvoiceschanged = populateVoiceList;

    // 2. 파일 업로드 및 드래그&드롭 이벤트 설정
    $fileInput.addEventListener('change', handleFiles);
    $('#file-upload-btn').addEventListener('click', () => $fileInput.click());
    
    setupDragAndDrop();

    // 3. 재생 컨트롤 및 설정 이벤트
    $('#play-pause-btn').addEventListener('click', togglePlayPause);
    $('#stop-btn').addEventListener('click', stopReading);
    $('#next-file-btn').addEventListener('click', () => changeFile(currentFileIndex + 1));
    $('#prev-file-btn').addEventListener('click', () => changeFile(currentFileIndex - 1));

    $rateSlider.addEventListener('input', updateRateDisplay);
    $rateSlider.addEventListener('change', () => saveBookmark());

    // 4. 북마크 로드 (설정 복원)
    loadBookmark();
    
    // 5. 텍스트 뷰어 클릭 이벤트 설정
    setupTextViewerClickEvent();

    // 6. 클립보드 입력 이벤트 설정
    $loadClipboardBtn.addEventListener('click', handleClipboardText);

    // 7. URL 입력 이벤트 설정 (새로운 부분)
    $loadUrlBtn.addEventListener('click', handleUrlText);
});

// 브라우저 종료 전 북마크 저장 (조건 8)
window.addEventListener('beforeunload', () => {
    saveBookmark();
    if (synth.speaking) {
        synth.cancel();
    }
});

// --- 목소리 및 설정 기능 ---

/**
 * 사용 가능한 목소리 목록을 가져와 드롭다운에 채우고 Google TTS를 기본으로 선택합니다.
 */
function populateVoiceList() {
    const voices = synth.getVoices();
    $voiceSelect.innerHTML = ''; 

    let koreanVoices = [];
    let googleKoreanVoiceName = null;
    let preferredVoiceName = null;
    let selectedVoice = null;

    // 1. 목소리 분류 및 Google TTS 찾기
    voices.forEach((voice) => {
        const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
        
        if (voice.lang.includes('ko')) {
            koreanVoices.push(option);
            
            // Google 목소리 패턴 찾기
            if (voice.name.includes('Google') || voice.name.includes('Standard') || voice.name.includes('Wavenet')) {
                 googleKoreanVoiceName = voice.name;
            }
        }
    });

    // 2. 한국어 목소리만 드롭다운에 추가
    koreanVoices.forEach(option => $voiceSelect.appendChild(option));

    // 3. 기본 목소리 설정 (Google TTS 우선)
    if (googleKoreanVoiceName) {
        preferredVoiceName = googleKoreanVoiceName;
    } else if (koreanVoices.length > 0) {
        preferredVoiceName = koreanVoices[0].value;
    }

    // 4. 북마크 데이터 또는 선호하는 목소리 설정
    const savedBookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));

    if (savedBookmark && savedBookmark.settings && $voiceSelect.querySelector(`option[value="${savedBookmark.settings.voice}"]`)) {
         selectedVoice = savedBookmark.settings.voice;
    } else if (preferredVoiceName) {
         selectedVoice = preferredVoiceName;
    }
    
    if(selectedVoice) {
         $voiceSelect.value = selectedVoice;
    }
    
    if (savedBookmark && savedBookmark.settings) {
        $rateSlider.value = savedBookmark.settings.rate;
    }

    updateRateDisplay();
}

/**
 * 속도 슬라이더 값에 따라 표시를 업데이트합니다.
 */
function updateRateDisplay() {
    $rateDisplay.textContent = $rateSlider.value;
}

// --- 파일 처리 및 분할 기능 ---

/**
 * URL에서 텍스트를 가져와 뷰어에 로드하고 처리합니다. (새로 추가된 비동기 함수)
 */
async function fetchAndProcessUrlContent(url) {
    if (!url) return;
    
    // CORS 문제를 해결하기 위한 공용 프록시 URL 설정.
    const PROXY_URL = 'https://cors-anywhere.herokuapp.com/'; 

    const targetUrl = PROXY_URL + url;
    
    try {
        $textViewer.innerHTML = '<p>웹페이지 콘텐츠를 불러오는 중입니다. (CORS 우회를 위해 프록시 서버를 사용합니다)...</p>';
        stopReading(); 

        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`HTTP 오류: ${response.status}`);
        }
        
        const htmlText = await response.text();

        // 텍스트에서 ID 'novel_content'의 innerText를 추출 (DOMParser 사용)
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        const novelContentElement = doc.getElementById('novel_content');

        let text = '';
        if (novelContentElement) {
            // textContent를 사용하여 요소 내의 모든 텍스트를 가져옵니다.
            text = novelContentElement.textContent || '';
            text = text.trim();
        } else {
            throw new Error("페이지에서 ID 'novel_content' 요소를 찾을 수 없습니다.");
        }

        if (text.length < 50) { // 너무 짧은 텍스트는 오류로 간주
             throw new Error("추출된 텍스트 내용이 너무 짧습니다. (요소 ID 또는 페이지 내용 확인 필요)");
        }

        // 파일 데이터 구조로 변환
        const fileId = Date.now();
        const fileName = `[URL] ${url.substring(0, 30)}...`;

        const newFileData = {
            id: fileId,
            name: fileName,
            fullText: text,
            chunks: [],
            isProcessed: false 
        };

        filesData.unshift(newFileData);
        
        if (filesData.length > MAX_FILES) {
            filesData.pop(); 
        }

        currentFileIndex = 0;
        currentChunkIndex = 0;
        
        renderFileList();
        processFileChunks(currentFileIndex, true);

        $urlTextInput.value = '';

    } catch (error) {
        alert(`URL 로드 실패: ${error.message}. 공용 프록시 서버(https://cors-anywhere.herokuapp.com/)를 먼저 방문하여 'Request temporary access' 버튼을 눌렀는지 확인해보세요.`);
        $textViewer.innerHTML = `<p style="color:red;">오류 발생: ${error.message}</p>`;
        renderFileList();
    }
}

/**
 * URL 로드 버튼 클릭 핸들러 (새로 추가된 함수)
 */
function handleUrlText() {
    const url = $urlTextInput.value.trim();
    if (url) {
        fetchAndProcessUrlContent(url);
    } else {
        alert("URL을 입력해주세요.");
    }
}

/**
 * 클립보드 입력 텍스트를 처리하여 뷰어에 로드합니다.
 */
function handleClipboardText() {
    const text = $clipboardTextInput.value.trim();
    if (!text) {
        alert("붙여넣기할 텍스트가 없습니다.");
        return;
    }

    // 파일 업로드와 동일한 데이터 구조로 변환
    const fileId = Date.now();
    const fileName = `[클립보드] ${new Date().toLocaleTimeString()}`;

    const newFileData = {
        id: fileId,
        name: fileName,
        fullText: text,
        chunks: [],
        isProcessed: false 
    };

    filesData.unshift(newFileData);
    
    if (filesData.length > MAX_FILES) {
        filesData.pop(); 
    }

    currentFileIndex = 0;
    currentChunkIndex = 0;
    
    renderFileList();
    processFileChunks(currentFileIndex, true);

    $clipboardTextInput.value = '';
}


/**
 * 파일 입력 이벤트 핸들러. (북마크 복원 로직 개선)
 */
function handleFiles(event) {
    const newFiles = Array.from(event.target.files).filter(file => file.name.toLowerCase().endsWith('.txt'));

    if (filesData.length + newFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부할 수 있습니다.`);
        newFiles.splice(MAX_FILES - filesData.length); 
    }
    
    const bookmarkData = localStorage.getItem('autumnReaderBookmark');
    
    newFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const fileId = Date.now() + filesData.length;
            
            const newFileData = {
                id: fileId,
                name: file.name,
                fullText: e.target.result,
                chunks: [],
                isProcessed: false 
            };
            filesData.push(newFileData);
            renderFileList();
            
            const newFileIndex = filesData.length - 1;

            let shouldResume = false;
            
            // 2. 북마크 체크 및 대화형 프롬프트
            if (bookmarkData) {
                const bookmark = JSON.parse(bookmarkData);
                if (file.name === bookmark.fileName) { 
                    const resume = confirm(`[북마크 복원] "${file.name}"의 저장된 위치(${bookmark.chunkIndex + 1}번째 청크)부터 이어서 읽으시겠습니까? \n\n'확인'을 누르면 이어서 읽고, '취소'를 누르면 처음부터 읽습니다.`);

                    if (resume) {
                        currentFileIndex = newFileIndex;
                        currentChunkIndex = bookmark.chunkIndex;
                        shouldResume = true;
                        processFileChunks(newFileIndex, true); 
                    }
                }
            }
            
            // 3. 기본 로직 
            if (!shouldResume) {
                if (currentFileIndex === -1) {
                    currentFileIndex = newFileIndex;
                    processFileChunks(currentFileIndex, true);
                } else {
                    setTimeout(() => processFileChunks(newFileIndex, false), 100);
                }
            }
        };
        reader.readAsText(file, 'UTF-8');
    });
    event.target.value = '';
}

/**
 * 드래그 앤 드롭 설정.
 */
function setupDragAndDrop() {
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        $dropArea.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        $dropArea.addEventListener(eventName, () => $dropArea.classList.add('active'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        $dropArea.addEventListener(eventName, () => $dropArea.classList.remove('active'), false);
    });

    $dropArea.addEventListener('drop', handleDrop, false);

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function handleDrop(e) {
        const dt = e.dataTransfer;
        $fileInput.files = dt.files;
        handleFiles({ target: $fileInput });
    }
}


/**
 * 텍스트를 문장 단위로 분할하여 chunks 배열에 저장합니다. (조건 4, 5)
 */
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
    
    if (file.chunks.length > 0) {
        file.isProcessed = true;
    }

    if (startReading) {
        renderTextViewer(fileIndex); 
        if (currentFileIndex === fileIndex) {
            startReadingFromCurrentChunk(); 
        }
    } else if (!startReading && fileIndex < filesData.length - 1) {
        setTimeout(() => processFileChunks(fileIndex + 1, false), 100);
    }
}

// --- 재생 컨트롤 기능 ---

/**
 * 현재 청크부터 읽기를 시작하거나 이어서 읽습니다.
 */
function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1 || isSpeaking) return;

    const file = filesData[currentFileIndex];
    if (!file || !file.isProcessed) {
        alert("텍스트 분할 처리 중입니다. 잠시 후 다시 시도해 주세요.");
        return;
    }

    currentChunkIndex = Math.min(currentChunkIndex, file.chunks.length - 1);
    
    renderTextViewer(currentFileIndex); 
    
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    synth.cancel();
    
    speakNextChunk();
}

/**
 * 다음 텍스트 청크를 발화합니다. (조건 4, 7)
 */
function speakNextChunk() {
    const file = filesData[currentFileIndex];
    
    if (!isSpeaking || isPaused) return; 
    
    if (currentChunkIndex >= file.chunks.length) {
        changeFile(currentFileIndex + 1);
        return;
    }

    const textToSpeak = file.chunks[currentChunkIndex];
    renderTextViewer(currentFileIndex); 

    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    
    // 설정 적용
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    currentUtterance.rate = parseFloat($rateSlider.value);
    currentUtterance.pitch = 1; 

    // 발화 종료 이벤트 (정주행 로직의 핵심)
    currentUtterance.onend = () => {
        currentChunkIndex++;
        saveBookmark(); 
        setTimeout(speakNextChunk, 50); 
    };
    
    currentUtterance.onpause = () => {
         isPaused = true;
    };

    synth.speak(currentUtterance);
}

/**
 * 재생/일시정지 토글. (조건 7)
 */
function togglePlayPause() {
    if (currentFileIndex === -1) return;

    if (isSpeaking && !isPaused) {
        synth.pause();
        isPaused = true;
        $playPauseBtn.textContent = '▶️';
    } else if (isSpeaking && isPaused) {
        synth.resume();
        isPaused = false;
        $playPauseBtn.textContent = '⏸️';
    } else {
        startReadingFromCurrentChunk();
    }
}

/**
 * 재생 정지 및 상태 초기화.
 */
function stopReading() {
    synth.cancel();
    isSpeaking = false;
    isPaused = false;
    currentChunkIndex = 0; 
    $playPauseBtn.textContent = '▶️';
    
    // 하이라이팅 초기화
    if(currentFileIndex !== -1) {
        renderTextViewer(currentFileIndex); 
    }
}

/**
 * 다음 또는 이전 파일로 이동 (정주행)
 */
function changeFile(newIndex) {
    if (newIndex < 0 || newIndex >= filesData.length) {
        alert("더 이상 읽을 파일이 없습니다.");
        stopReading();
        return;
    }
    
    synth.cancel(); 
    currentFileIndex = newIndex;
    currentChunkIndex = 0; 
    
    if (!filesData[newIndex].isProcessed) {
        processFileChunks(newIndex, true);
    }
    
    renderTextViewer(newIndex); 
    
    if (isSpeaking) {
        startReadingFromCurrentChunk();
    }
}

// --- UI 및 북마크 기능 ---

/**
 * 텍스트 뷰어에 해당 파일의 내용을 표시하고 클릭 이벤트를 설정합니다. (조건 6, 재생 위치 이동)
 * @param {number} fileIndex - 파일 인덱스
 */
function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex] || !filesData[fileIndex].isProcessed) {
        const text = fileIndex !== -1 ? filesData[fileIndex].fullText : '';
        $textViewer.innerHTML = text.replace(/\n/g, '<br>') || '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
        renderFileList();
        return;
    }
    
    const file = filesData[fileIndex];
    const allChunks = file.chunks;
    let htmlContent = '';
    
    allChunks.forEach((chunk, index) => {
        let chunkHtml = chunk.replace(/\n/g, '<br>');
        
        const isCurrentChunk = index === currentChunkIndex && (isSpeaking || isPaused);

        htmlContent += `<span class="text-chunk ${isCurrentChunk ? 'highlight' : ''}" data-index="${index}">${chunkHtml}</span>`;
    });

    $textViewer.innerHTML = htmlContent;
    renderFileList();

    // 스크롤 이동
    if (isSpeaking || isPaused) {
         setTimeout(scrollToCurrentChunk, 100);
    }
}

/**
 * 현재 하이라이트된 청크로 스크롤을 이동합니다.
 */
function scrollToCurrentChunk() {
    const highlighted = $('.highlight');
    if (highlighted) {
        highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}


/**
 * 텍스트 뷰어에 클릭 이벤트를 설정하여 재생 위치를 이동합니다. (현재 하이라이트된 청크 클릭 방지 로직 추가)
 */
function setupTextViewerClickEvent() {
    $textViewer.addEventListener('click', (e) => {
        const chunkElement = e.target.closest('.text-chunk');
        if (!chunkElement) return;
        
        // 현재 하이라이트된 청크(.highlight)라면 클릭 이벤트를 무시
        if (chunkElement.classList.contains('highlight')) {
            return; 
        }

        const newChunkIndex = parseInt(chunkElement.dataset.index);
        if (isNaN(newChunkIndex)) return;

        jumpToChunk(newChunkIndex);
    });
}

/**
 * 지정된 청크 인덱스로 재생 위치를 이동하고 재생을 시작합니다.
 * @param {number} index - 이동할 청크의 인덱스
 */
function jumpToChunk(index) {
    if (currentFileIndex === -1 || index >= filesData[currentFileIndex].chunks.length) return;

    // 현재 발화 중인 TTS 중지
    synth.cancel();

    // 상태 업데이트
    currentChunkIndex = index;
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    // UI 업데이트 및 재생 시작
    renderTextViewer(currentFileIndex);
    speakNextChunk();
}


/**
 * 파일 목록 UI를 업데이트합니다.
 */
function renderFileList() {
    $fileList.innerHTML = '';
    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.textContent = file.name;
        li.dataset.fileId = file.id;
        li.classList.toggle('active', index === currentFileIndex);
        
        li.addEventListener('click', () => {
            if (index !== currentFileIndex) {
                changeFile(index);
            }
        });
        
        $fileList.appendChild(li);
    });
}

/**
 * 현재 상태를 localStorage에 저장합니다. (조건 8)
 */
function saveBookmark() {
    if (currentFileIndex === -1) return;
    
    const bookmarkData = {
        fileId: filesData[currentFileIndex].id,
        fileName: filesData[currentFileIndex].name, 
        chunkIndex: currentChunkIndex,
        settings: { 
            voice: $voiceSelect.value, 
            rate: $rateSlider.value 
        }
    };
    localStorage.setItem('autumnReaderBookmark', JSON.stringify(bookmarkData));
}

/**
 * localStorage에서 북마크 설정만 로드합니다. (파일 위치 복원은 handleFiles에서 처리)
 */
function loadBookmark() {
    const data = localStorage.getItem('autumnReaderBookmark');
    if (!data) return;

    const bookmark = JSON.parse(data);
    
    if (bookmark.settings) {
         $rateSlider.value = bookmark.settings.rate;
         updateRateDisplay();
    }
}