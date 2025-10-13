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
    
    // 속도 설정도 여기서 업데이트 (loadBookmark에서 중복 처리 방지)
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
            // 1. 파일 데이터 준비
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
            
            // 2. 북마크 체크 및 대화형 프롬프트 (가장 중요한 수정 부분)
            if (bookmarkData) {
                const bookmark = JSON.parse(bookmarkData);
                // 파일 이름이 일치하는 경우
                if (file.name === bookmark.fileName) { 
                    const resume = confirm(`[북마크 복원] "${file.name}"의 저장된 위치(${bookmark.chunkIndex + 1}번째 청크)부터 이어서 읽으시겠습니까? \n\n'확인'을 누르면 이어서 읽고, '취소'를 누르면 처음부터 읽습니다.`);

                    if (resume) {
                        currentFileIndex = newFileIndex;
                        currentChunkIndex = bookmark.chunkIndex;
                        shouldResume = true;
                        // 즉시 처리하고 재생 준비
                        processFileChunks(newFileIndex, true); 
                    }
                }
            }
            
            // 3. 기본 로직 (북마크가 없거나, 복원하지 않기로 선택한 경우)
            if (!shouldResume) {
                if (currentFileIndex === -1) {
                    // 첫 파일이면 현재 파일로 설정하고 처리 시작 (읽기 준비)
                    currentFileIndex = newFileIndex;
                    processFileChunks(currentFileIndex, true);
                } else {
                    // 이미 다른 파일이 선택되어 있으면, 백그라운드에서 처리 예약
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
        renderTextViewer(fileIndex); // 텍스트 뷰어 렌더링
        if (currentFileIndex === fileIndex) {
            startReadingFromCurrentChunk(); 
        }
    } else if (!startReading && fileIndex < filesData.length - 1) {
        // 백그라운드 처리 완료 후 다음 파일 처리 예약
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
    
    renderTextViewer(currentFileIndex); // 텍스트 뷰어에 현재 파일의 전체 텍스트 로드 및 하이라이트
    
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
    renderTextViewer(currentFileIndex); // 하이라이트 업데이트 및 스크롤

    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    
    // 설정 적용
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    currentUtterance.rate = parseFloat($rateSlider.value);
    currentUtterance.pitch = 1; 

    // 발화 종료 이벤트 (정주행 로직의 핵심)
    currentUtterance.onend = () => {
        currentChunkIndex++;
        saveBookmark(); // 매 청크 끝날 때마다 북마크 자동 저장
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
    currentChunkIndex = 0; // 정지하면 처음부터 다시 시작
    $playPauseBtn.textContent = '▶️';
    
    // 하이라이팅 초기화
    if(currentFileIndex !== -1) {
        renderTextViewer(currentFileIndex); // 하이라이트 제거 후 텍스트 렌더링
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
    
    synth.cancel(); // 현재 발화 중단
    currentFileIndex = newIndex;
    currentChunkIndex = 0; // 새 파일은 처음부터 시작
    
    if (!filesData[newIndex].isProcessed) {
        // 다음 파일이 처리되지 않았다면 처리 시작 (읽기 시작을 위해)
        processFileChunks(newIndex, true);
    }
    
    renderTextViewer(newIndex); // 텍스트 뷰어 렌더링
    
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
        // 파일이 없거나 아직 처리되지 않은 경우, 원본 텍스트 표시
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
        
        // 현재 발화 중이거나 일시정지된 청크에만 하이라이트 적용
        const isCurrentChunk = index === currentChunkIndex && (isSpeaking || isPaused);

        // 각 청크를 클릭 가능한 span으로 감싸고 data-index 속성을 부여
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
 * 텍스트 뷰어에 클릭 이벤트를 설정하여 재생 위치를 이동합니다.
 */
function setupTextViewerClickEvent() {
    $textViewer.addEventListener('click', (e) => {
        const chunkElement = e.target.closest('.text-chunk');
        if (!chunkElement) return;

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
                // 파일 변경 시, 해당 파일이 처리되지 않았다면 처리 시작 플래그를 true로 넘겨줌
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
        fileName: filesData[currentFileIndex].name, // 파일 이름 추가 (복원 시 매칭용)
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
    
    // 설정 복원 (목소리 설정은 populateVoiceList에서 처리)
    if (bookmark.settings) {
         $rateSlider.value = bookmark.settings.rate;
         updateRateDisplay();
    }
}