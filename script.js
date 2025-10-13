// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개로 설정
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수 (Web Speech API 안정성 고려)

let filesData = []; // 업로드된 모든 파일의 데이터 저장 ({ id, name, fullText, chunks, isProcessed })
let currentFileIndex = -1;
let currentChunkIndex = 0;
let isSequential = true; // 정주행 기능 상태 (기본값: true)

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

// --- 추가된 DOM 요소 ---
const $clipboardTextInput = $('#clipboard-text-input');
const $loadClipboardBtn = $('#load-clipboard-btn');
const $urlTextInput = $('#url-text-input');
const $loadUrlBtn = $('#load-url-btn');
const $sequentialReadCheckbox = $('#sequential-read-checkbox'); // 정주행 체크박스
const $clearAllFilesBtn = $('#clear-all-files-btn'); // 전체 삭제 버튼
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

    // 7. URL 입력 이벤트 설정
    $loadUrlBtn.addEventListener('click', handleUrlText);

    // 8. 정주행 체크박스 이벤트 설정
    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
        saveBookmark(); 
    });
    // 북마크에서 정주행 상태 복원
    if(localStorage.getItem('autumnReaderBookmark')) {
        const bookmark = JSON.parse(localStorage.getItem('autumnReaderBookmark'));
        isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    }
    $sequentialReadCheckbox.checked = isSequential;

    // 9. 전체 삭제 버튼 이벤트 설정
    $clearAllFilesBtn.addEventListener('click', clearAllFiles);
    
    // 10. 파일 목록 클릭 이벤트 위임 (개별 재생, 삭제)
    $fileList.addEventListener('click', handleFileListItemClick);
    
    // 11. 드래그 앤 드롭을 위한 sortablejs 설정
    setupFileListSortable();
});

// 브라우저 종료 전 북마크 저장
window.addEventListener('beforeunload', () => {
    saveBookmark();
    if (synth.speaking) {
        synth.cancel();
    }
});

// --- 목소리 및 설정 기능 ---

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

    koreanVoices.forEach(option => $voiceSelect.appendChild(option));

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
    }
    
    if(selectedVoice) {
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

// --- 파일 처리 및 분할 기능 ---

/**
 * URL에서 텍스트를 가져와 뷰어에 로드하고 처리합니다.
 */
async function fetchAndProcessUrlContent(url) {
    if (!url) return;
    
    // 새로운 공용 프록시 서버 (api.allorigins.win)를 사용하여 CORS 문제를 우회합니다.
    const PROXY_URL = 'https://api.allorigins.win/raw?url='; 

    // 대상 URL을 URL 인코딩하여 프록시 서버의 매개변수로 안전하게 전달합니다.
    const targetUrl = PROXY_URL + encodeURIComponent(url);
    
    try {
        $textViewer.innerHTML = '<p>웹페이지 콘텐츠를 불러오는 중입니다. (프록시 서버 사용)...</p>';
        stopReading(); 

        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`HTTP 오류: ${response.status}`);
        }
        
        const htmlText = await response.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        // ID 'novel_content' 요소에서 텍스트를 추출합니다.
        const novelContentElement = doc.getElementById('novel_content');

        let text = '';
        if (novelContentElement) {
            text = novelContentElement.textContent || '';
            text = text.trim();
        } else {
            throw new Error("페이지에서 ID 'novel_content' 요소를 찾을 수 없습니다.");
        }

        if (text.length < 50) { 
             throw new Error("추출된 텍스트 내용이 너무 짧습니다. (요소 ID 또는 페이지 내용 확인 필요)");
        }

        const fileId = Date.now();
        const fileName = `[URL] ${url.substring(0, 30)}...`;

        const newFileData = {
            id: fileId,
            name: fileName,
            fullText: text,
            chunks: [],
            isProcessed: false 
        };

        // 자동 재생 방지: filesData에 추가만 하고 currentFileIndex를 변경하지 않습니다.
        filesData.unshift(newFileData);
        
        if (filesData.length > MAX_FILES) {
            filesData.pop(); 
        }

        renderFileList();
        // URL을 로드한 파일은 바로 청크를 처리합니다. (재생 시작 안 함)
        processFileChunks(0, false); 

        $urlTextInput.value = '';

    } catch (error) {
        alert(`URL 로드 실패: ${error.message}. 프록시 서버 문제일 수 있습니다. 다른 URL로 시도하거나 잠시 후 다시 시도해 보세요.`);
        $textViewer.innerHTML = `<p style="color:red;">오류 발생: ${error.message}</p>`;
        renderFileList();
    }
}

function handleUrlText() {
    const url = $urlTextInput.value.trim();
    if (url) {
        fetchAndProcessUrlContent(url);
    } else {
        alert("URL을 입력해주세요.");
    }
}

function handleClipboardText() {
    const text = $clipboardTextInput.value.trim();
    if (!text) {
        alert("붙여넣기할 텍스트가 없습니다.");
        return;
    }

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

    renderFileList();
    // 클립보드 텍스트도 바로 청크를 처리합니다. (재생 시작 안 함)
    processFileChunks(0, false); 

    $clipboardTextInput.value = '';
}


/**
 * 파일 입력 이벤트 핸들러. (Promise.all을 사용해 파일 로딩 후 정렬 및 처리)
 */
function handleFiles(event) {
    const newFiles = Array.from(event.target.files).filter(file => file.name.toLowerCase().endsWith('.txt'));
    
    // --- 파일 개수 제한 로직 ---
    if (filesData.length + newFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부할 수 있습니다.`);
        newFiles.splice(MAX_FILES - filesData.length); 
    }
    
    if (newFiles.length === 0) {
        event.target.value = '';
        return;
    }
    // ----------------------------

    const bookmarkData = localStorage.getItem('autumnReaderBookmark');
    let resumeTargetFileName = JSON.parse(bookmarkData)?.fileName;
    let chunkIndexForResume = JSON.parse(bookmarkData)?.chunkIndex || 0;
    let newFileIndexForResume = -1;

    // 1. 모든 파일 읽기를 Promise로 감싸서 비동기 처리
    const filePromises = newFiles.map(file => {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                // ID는 고유성을 위해 Date.now() + Math.random() 사용
                const fileId = Date.now() + Math.random(); 
                
                const newFileData = {
                    id: fileId,
                    name: file.name,
                    fullText: e.target.result,
                    chunks: [],
                    isProcessed: false 
                };
                resolve(newFileData);
            };
            // UTF-8로 읽기
            reader.readAsText(file, 'UTF-8');
        });
    });

    // 2. 모든 파일 읽기가 완료되면 정렬 및 처리 시작
    Promise.all(filePromises).then(newlyReadFiles => {
        
        // --- 파일명 기준 오름차순 정렬 (핵심 요구사항) ---
        newlyReadFiles.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));

        // 새로 추가되는 파일들이 filesData에 들어갈 시작 인덱스
        const startIndex = filesData.length;
        
        // 3. 정렬된 파일을 filesData에 추가
        filesData.push(...newlyReadFiles);
        
        // 4. 북마크 복원 대상 파일 확인 및 인덱스 설정
        let shouldResume = false;
        if (resumeTargetFileName) {
            const resumeFileIndexInNewList = newlyReadFiles.findIndex(f => f.name === resumeTargetFileName);
            if (resumeFileIndexInNewList !== -1) {
                newFileIndexForResume = startIndex + resumeFileIndexInNewList;
                shouldResume = true;
            }
        }
        
        // 5. 북마크 복원 프롬프트 및 로직 실행
        if (shouldResume) {
            const resume = confirm(`[북마크 복원] "${filesData[newFileIndexForResume].name}"의 저장된 위치(${chunkIndexForResume + 1}번째 청크)부터 이어서 읽으시겠습니까?`);

            if (resume) {
                currentFileIndex = newFileIndexForResume;
                currentChunkIndex = chunkIndexForResume;
                // 북마크 복원 시에만 재생 시작
                processFileChunks(currentFileIndex, true); 
                // 나머지 파일들은 비동기로 청크만 처리 (재생 시작 안 함)
                processFileChunksInSequence(startIndex, currentFileIndex);
            } else {
                 // Resume 취소: 모든 파일 비동기 청크 처리 (재생 시작 안 함)
                 processFileChunksInSequence(startIndex, -1);
            }
        } else {
            // 북마크 대상 파일이 없거나, 기존 파일이 없다면 첫 번째 파일을 현재 파일로 설정 (자동 재생은 안 함)
            if (currentFileIndex === -1) {
                currentFileIndex = startIndex; 
            }
            // 모든 파일 비동기 청크 처리 (재생 시작 안 함)
            processFileChunksInSequence(startIndex, -1);
        }
        
        // UI 갱신 (파일 리스트에 정렬된 순서대로 표시)
        renderFileList();
    });
    
    event.target.value = '';
}

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

    if (startReading && currentFileIndex === fileIndex) {
        renderTextViewer(fileIndex); 
        startReadingFromCurrentChunk(); 
    } 
}

/**
 * 새로 추가된 파일들 (startIndex부터)에 대해 비동기로 청크를 처리합니다.
 * @param {number} startIndex - filesData에서 새로 추가된 파일의 시작 인덱스.
 * @param {number} skipIndex - 이미 processFileChunks(..., true)로 처리 중인 파일 인덱스 (-1이면 없음).
 */
function processFileChunksInSequence(startIndex, skipIndex) {
    for(let i = startIndex; i < filesData.length; i++) {
        if (i === skipIndex) continue; // 이미 처리 중인 파일은 건너뜁니다.

        // 파일 처리가 브라우저를 멈추지 않도록 작은 지연을 줍니다.
        setTimeout(() => processFileChunks(i, false), 100 * (i - startIndex));
    }
}

// --- 재생 컨트롤 기능 ---

function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1) return;

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

function speakNextChunk() {
    const file = filesData[currentFileIndex];
    
    if (!isSpeaking || isPaused) return; 
    
    if (currentChunkIndex >= file.chunks.length) {
        // 정주행 기능 로직 추가
        if (isSequential) {
            changeFile(currentFileIndex + 1);
        } else {
            // 정주행이 아니면 재생 목록 끝에서 멈춥니다.
            stopReading();
        }
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

function togglePlayPause() {
    if (currentFileIndex === -1) {
        alert("재생할 파일을 먼저 선택해주세요.");
        return;
    }

    if (isSpeaking && !isPaused) {
        synth.pause();
        isPaused = true;
        $playPauseBtn.textContent = '▶️';
    } else if (isSpeaking && isPaused) {
        synth.resume();
        isPaused = false;
        $playPauseBtn.textContent = '⏸️';
    } else {
        // 재생 버튼을 누르면 현재 파일에서 재생을 시작
        startReadingFromCurrentChunk();
    }
}

function stopReading() {
    synth.cancel();
    isSpeaking = false;
    isPaused = false;
    currentChunkIndex = 0; 
    $playPauseBtn.textContent = '▶️';
    
    if(currentFileIndex !== -1) {
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
    
    if (!filesData[newIndex].isProcessed) {
        processFileChunks(newIndex, true);
    } else {
        renderTextViewer(newIndex); 
        if (isSpeaking) {
            startReadingFromCurrentChunk();
        }
    }
}

// --- 파일 목록 관리 기능 ---

/**
 * 파일 목록 아이템 클릭 핸들러 (개별 재생, 삭제 위임)
 */
function handleFileListItemClick(e) {
    const li = e.target.closest('li');
    if (!li) return;
    
    const fileId = parseInt(li.dataset.fileId);
    const fileIndex = filesData.findIndex(f => f.id === fileId);
    if (fileIndex === -1) return;

    // 1. 삭제 버튼 클릭 시
    if (e.target.classList.contains('delete-file-btn')) {
        deleteFile(fileIndex);
        return;
    }
    
    // 2. 순서 변경 버튼 클릭 시 (Sortable.js가 처리하므로 무시)
    if (e.target.classList.contains('drag-handle')) {
        return;
    }

    // 3. 파일 이름 영역 클릭 시 (재생 시작/파일 선택)
    if (fileIndex !== currentFileIndex) {
        // 현재 파일 변경 및 뷰어 로드 (재생은 시작하지 않음)
        currentFileIndex = fileIndex;
        currentChunkIndex = 0; 
        renderTextViewer(currentFileIndex);
    } else if (currentFileIndex === fileIndex && !isSpeaking) {
        // 현재 파일을 클릭했는데 재생 중이 아니라면, 재생 시작
        startReadingFromCurrentChunk();
    }
    
    // 파일 목록이 변경된 경우 뷰어 로드만 진행
    renderTextViewer(currentFileIndex);
}

/**
 * 개별 파일 삭제
 */
function deleteFile(index) {
    if (index === -1) return;

    const wasCurrentFile = index === currentFileIndex;

    filesData.splice(index, 1);
    
    if (wasCurrentFile) {
        stopReading();
        currentFileIndex = filesData.length > 0 ? 0 : -1;
        currentChunkIndex = 0;
        renderTextViewer(currentFileIndex);
    } else if (index < currentFileIndex) {
        currentFileIndex--; 
    }
    
    renderFileList();
    saveBookmark(); 

    if (filesData.length === 0) {
        $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
        currentFileIndex = -1;
    }
}

/**
 * 전체 파일 삭제
 */
function clearAllFiles() {
    if (filesData.length === 0) return;
    if (!confirm("첨부된 파일 전체를 삭제하시겠습니까?")) return;

    stopReading();
    filesData = [];
    currentFileIndex = -1;
    currentChunkIndex = 0;
    
    localStorage.removeItem('autumnReaderBookmark');
    
    renderFileList();
    $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
}


/**
 * SortableJS를 사용하여 파일 목록 순서 변경 기능을 활성화합니다.
 */
function setupFileListSortable() {
    // SortableJS가 index.html에서 로드되었는지 확인
    if (typeof Sortable === 'undefined') {
        // SortableJS 라이브러리가 로드되지 않은 경우 경고 후 종료
        return; 
    }

    new Sortable($fileList, {
        handle: '.drag-handle', // 햄버거 버튼(.drag-handle)을 핸들로 지정
        animation: 150,
        onEnd: function (evt) {
            const oldIndex = evt.oldIndex;
            const newIndex = evt.newIndex;
            
            // filesData 배열에서 요소 순서 변경
            const [movedItem] = filesData.splice(oldIndex, 1);
            filesData.splice(newIndex, 0, movedItem);

            // currentFileIndex 조정
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


// --- UI 및 북마크 기능 ---

function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) {
        $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
        renderFileList();
        return;
    }

    const file = filesData[fileIndex];

    if (!file.isProcessed) {
        // 청크 처리 전에는 전체 텍스트를 보여줍니다.
        $textViewer.innerHTML = `<p style="color:#FFD700;">[파일 로딩 중/청크 처리 중] : ${file.name}</p>` + file.fullText.replace(/\n/g, '<br>');
        renderFileList();
        return;
    }

    const allChunks = file.chunks;
    let htmlContent = '';
    
    allChunks.forEach((chunk, index) => {
        let chunkHtml = chunk.replace(/\n/g, '<br>');
        
        const isCurrentChunk = index === currentChunkIndex && (isSpeaking || isPaused);

        htmlContent += `<span class="text-chunk ${isCurrentChunk ? 'highlight' : ''}" data-index="${index}">${chunkHtml}</span>`;
    });

    $textViewer.innerHTML = htmlContent;
    renderFileList();

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
    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';

    renderTextViewer(currentFileIndex);
    speakNextChunk();
}


/**
 * 파일 목록 UI를 업데이트합니다. (삭제/순서 변경 버튼 추가)
 */
function renderFileList() {
    $fileList.innerHTML = '';
    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.fileId = file.id;

        // 1. 파일 이름 표시 영역
        const fileNameSpan = document.createElement('span');
        fileNameSpan.textContent = file.name;
        fileNameSpan.classList.add('file-item-name');
        
        // 2. 컨트롤 버튼 영역
        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('file-controls');

        // 2-1. 순서 변경 버튼 (햄버거 버튼)
        const dragHandle = document.createElement('button');
        dragHandle.innerHTML = '☰'; // 햄버거 아이콘
        dragHandle.classList.add('drag-handle');
        dragHandle.title = '순서 변경';

        // 2-2. 개별 삭제 버튼 (X)
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = 'X';
        deleteBtn.classList.add('delete-file-btn');
        deleteBtn.title = '파일 삭제';
        
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
        isSequential: isSequential, // 정주행 상태 저장
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
    
    // 설정 복구
    if (bookmark.settings) {
         $rateSlider.value = bookmark.settings.rate;
         updateRateDisplay();
    }
    
    // 정주행 상태 복구
    isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    if ($sequentialReadCheckbox) {
        $sequentialReadCheckbox.checked = isSequential;
    }
}