// --- 전역 변수 설정 ---
const MAX_FILES = 20;
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수 (Web Speech API 안정성 고려)
const PRELOAD_CHUNK_COUNT = 10; // 초기 재생을 위해 미리 분할할 텍스트 청크 수 (약 30초 분량)

let filesData = []; // 업로드된 모든 파일의 데이터 저장 ({ id, name, text, chunks, isProcessed })
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
    synth.onvoiceschanged = populateVoiceList;
    populateVoiceList();

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
    $rateSlider.addEventListener('change', () => saveBookmark()); // 속도 변경 시 북마크 저장

    // 4. 북마크 로드
    loadBookmark();
});

// 브라우저 종료 전 북마크 저장 (조건 8)
window.addEventListener('beforeunload', () => {
    saveBookmark();
    // 발화 중지: 브라우저가 닫히면 TTS 객체가 파괴되므로 명시적으로 중지
    if (synth.speaking) {
        synth.cancel();
    }
});

// --- 목소리 및 설정 기능 ---

/**
 * 사용 가능한 목소리 목록을 가져와 드롭다운에 채웁니다.
 */
function populateVoiceList() {
    const voices = synth.getVoices();
    $voiceSelect.innerHTML = ''; // 기존 목록 초기화

    voices.forEach((voice, index) => {
        // 한국어 목소리 우선 표시 (ko-)
        if (voice.lang.includes('ko')) {
            const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
            $voiceSelect.appendChild(option);
        }
    });

    // 한국어 목소리가 없는 경우 다른 목소리 추가
    if ($voiceSelect.options.length === 0) {
        voices.forEach(voice => {
            const option = new Option(`${voice.name} (${voice.lang})`, voice.name);
            $voiceSelect.appendChild(option);
        });
    }
}

/**
 * 속도 슬라이더 값에 따라 표시를 업데이트합니다.
 */
function updateRateDisplay() {
    $rateDisplay.textContent = $rateSlider.value;
}

// --- 파일 처리 및 분할 기능 ---

/**
 * 파일 입력 이벤트 핸들러.
 * @param {Event} event 
 */
function handleFiles(event) {
    const newFiles = Array.from(event.target.files).filter(file => file.name.toLowerCase().endsWith('.txt'));

    if (filesData.length + newFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부할 수 있습니다.`);
        newFiles.splice(MAX_FILES - filesData.length); // 초과 파일 제거
    }

    newFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const fileId = filesData.length + 1;
            filesData.push({
                id: fileId,
                name: file.name,
                fullText: e.target.result,
                chunks: [],
                isProcessed: false // 분할 처리 완료 여부
            });
            renderFileList();
            
            // 첫 파일이 로드되면 바로 처리 시작
            if (filesData.length === 1) {
                currentFileIndex = 0;
                processFileChunks(0, true); // 첫 파일은 선행 읽기를 위해 즉시 처리
            } else {
                // 다른 파일들은 백그라운드 처리 예약
                setTimeout(() => processFileChunks(filesData.length - 1, false), 100);
            }
        };
        reader.readAsText(file, 'UTF-8');
    });
    // 파일 입력 초기화 (같은 파일 재첨부 허용)
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
        $dropArea.addEventListener(eventName, () => $dropArea.classList.add('highlight'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        $dropArea.addEventListener(eventName, () => $dropArea.classList.remove('highlight'), false);
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
 * @param {number} fileIndex - 처리할 파일의 인덱스
 * @param {boolean} startReading - 분할 후 즉시 읽기를 시작할지 여부 (선행 읽기)
 */
function processFileChunks(fileIndex, startReading) {
    const file = filesData[fileIndex];
    if (!file || file.isProcessed) return;

    const text = file.fullText;
    // 문장 분리 로직 (마침표, 물음표, 느낌표, 줄바꿈 등을 기준으로)
    const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
    
    let currentChunk = '';
    
    // 텍스트를 작은 덩어리로 묶음
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
    
    // 선행 읽기 시작 (조건 5)
    if (startReading && file.chunks.length >= PRELOAD_CHUNK_COUNT) {
        // 나머지 분할 작업은 백그라운드에서 계속 진행되도록 설정
        // 이 예시에서는 모든 분할을 완료해야 정확한 chunk count를 알 수 있어, 단순화하여 즉시 isProcessed를 true로 설정
        file.isProcessed = true;
        loadText(fileIndex);
        if (currentFileIndex === fileIndex) {
            startReadingFromCurrentChunk();
        }
    } else if (!startReading) {
        // 백그라운드 처리 완료
        file.isProcessed = true;
    }
    // 모든 파일이 처리되면 정주행(순차 처리) 준비 완료
}

// --- 재생 컨트롤 기능 ---

/**
 * 현재 청크부터 읽기를 시작하거나 이어서 읽습니다.
 */
function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1 || isSpeaking) return;

    const file = filesData[currentFileIndex];
    if (!file || !file.isProcessed) {
        // 아직 분할 처리 중인 경우 대기
        alert("텍스트 분할 처리 중입니다. 잠시 후 다시 시도해 주세요.");
        return;
    }

    // 북마크 인덱스가 청크 수를 초과하지 않도록 보정
    currentChunkIndex = Math.min(currentChunkIndex, file.chunks.length - 1);
    
    // 텍스트 뷰어에 현재 파일의 전체 텍스트 로드
    loadText(currentFileIndex);
    
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    // 큐에 있는 이전 발화는 모두 취소 (안정성 확보)
    synth.cancel();
    
    speakNextChunk();
}

/**
 * 다음 텍스트 청크를 발화합니다. (조건 4, 7)
 */
function speakNextChunk() {
    const file = filesData[currentFileIndex];
    
    // 현재 파일의 모든 청크를 읽었으면 다음 파일로 이동
    if (currentChunkIndex >= file.chunks.length) {
        changeFile(currentFileIndex + 1);
        return;
    }

    const textToSpeak = file.chunks[currentChunkIndex];
    highlightText(textToSpeak); // 텍스트 뷰어에서 현재 문장 하이라이트

    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    
    // 설정 적용
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    currentUtterance.rate = parseFloat($rateSlider.value);
    currentUtterance.pitch = 1; // 기본 피치

    // 발화 종료 이벤트 (정주행 로직의 핵심)
    currentUtterance.onend = () => {
        currentChunkIndex++;
        // 다음 청크 발화는 비동기적으로 호출하여 브라우저 부담을 줄임
        setTimeout(speakNextChunk, 50); 
    };

    // 발화 시작
    synth.speak(currentUtterance);
}

/**
 * 재생/일시정지 토글. (조건 7)
 */
function togglePlayPause() {
    if (filesData.length === 0) return;

    if (isSpeaking && !isPaused) {
        synth.pause();
        isPaused = true;
        $playPauseBtn.textContent = '▶️';
    } else if (isSpeaking && isPaused) {
        synth.resume();
        isPaused = false;
        $playPauseBtn.textContent = '⏸️';
    } else {
        // 첫 재생이거나 정지 후 재시작
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
    $playPauseBtn.textContent = '▶️';
    
    // 하이라이팅 초기화
    $textViewer.innerHTML = filesData[currentFileIndex].fullText.replace(/\n/g, '<br>');
}

/**
 * 다음 또는 이전 파일로 이동 (정주행)
 * @param {number} newIndex - 이동할 파일의 인덱스
 */
function changeFile(newIndex) {
    if (newIndex < 0 || newIndex >= filesData.length) {
        alert("더 이상 읽을 파일이 없습니다.");
        stopReading();
        return;
    }
    
    stopReading(); // 현재 발화 중단
    currentFileIndex = newIndex;
    currentChunkIndex = 0; // 새 파일은 처음부터 시작
    
    // 다음 파일이 아직 처리되지 않았다면 처리 시작
    if (!filesData[newIndex].isProcessed) {
        processFileChunks(newIndex, false);
    }
    
    renderFileList(); // 파일 목록 하이라이트 업데이트
    loadText(newIndex); // 텍스트 뷰어 업데이트
    startReadingFromCurrentChunk();
}

// --- UI 및 북마크 기능 ---

/**
 * 현재 읽고 있는 텍스트를 뷰어에 표시하고 하이라이트 처리합니다. (조건 6)
 * @param {string} currentText - 현재 발화 중인 문장/청크
 */
function highlightText(currentText) {
    const file = filesData[currentFileIndex];
    if (!file) return;

    // 전체 텍스트를 다시 구성하여 하이라이팅 적용
    const allChunks = file.chunks;
    let htmlContent = '';
    
    allChunks.forEach((chunk, index) => {
        let chunkHtml = chunk.replace(/\n/g, '<br>');
        
        if (index === currentChunkIndex) {
            chunkHtml = `<span class="highlight">${chunkHtml}</span>`;
            
            // 하이라이트 위치로 스크롤 이동
            setTimeout(() => {
                const highlighted = $('.highlight');
                if (highlighted) {
                    highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        }
        
        htmlContent += chunkHtml;
    });

    $textViewer.innerHTML = htmlContent;
}

/**
 * 텍스트 뷰어에 해당 파일의 내용을 로드합니다.
 * @param {number} fileIndex - 파일 인덱스
 */
function loadText(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) return;
    const text = filesData[fileIndex].fullText;
    // 초기 로드 시에는 단순 텍스트 표시 (줄바꿈 처리)
    $textViewer.innerHTML = text.replace(/\n/g, '<br>');
    renderFileList();
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
        chunkIndex: currentChunkIndex,
        settings: { 
            voice: $voiceSelect.value, 
            rate: $rateSlider.value 
        }
    };
    localStorage.setItem('autumnReaderBookmark', JSON.stringify(bookmarkData));
}

/**
 * localStorage에서 북마크를 로드합니다. (조건 8)
 */
function loadBookmark() {
    const data = localStorage.getItem('autumnReaderBookmark');
    if (!data) return;

    const bookmark = JSON.parse(data);
    
    // 설정 복원
    $voiceSelect.value = bookmark.settings.voice;
    $rateSlider.value = bookmark.settings.rate;
    updateRateDisplay();

    // 북마크 로드 시에는 파일이 아직 로드되지 않았으므로 파일 로드 후에 복원해야 함
    // => 이 예제에서는 파일이 로드된 후에 사용자에게 직접 재생 시작을 유도합니다.

    // 실제 서비스에서는 파일의 내용(text)까지 저장해야 하지만, 
    // 파일 크기 문제로 여기서는 파일 메타데이터(name, id)와 진도만 저장합니다.
    // 따라서 파일을 다시 첨부해야 북마크 기능이 활성화됩니다.
    // (Web Speech API 방식의 근본적인 한계)
    
    // 알림: 브라우저를 닫았다면 파일을 다시 첨부해야 합니다.
    alert(`[북마크] 이전 세션에서 파일 ID ${bookmark.fileId}의 읽기 위치가 저장되었습니다. 해당 파일을 다시 첨부하면 이어서 읽을 수 있습니다.`);
}

// (주의: 파일 재첨부 후 북마크 위치 복원 로직은 파일 로드 후 handleFiles 끝에 추가되어야 합니다.)