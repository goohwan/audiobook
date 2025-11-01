// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i; // URL 인식 패턴

// --- 파일 관련 상수 추가 ---
const TEXT_EXTENSIONS = ['.txt', 'pdf'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.tif'];
const ALLOWED_EXTENSIONS = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS, '.xlsx', '.xls', '.csv']; // 엑셀/CSV 확장자 추가

// filesData 구조: { id, name, fullText(텍스트파일 또는 OCR 결과), fileObject(이미지파일 객체), isImage, chunks, isProcessed(청크까지 완료), isOcrProcessing }
let filesData = []; 
let currentFileIndex = -1;
let currentChunkIndex = 0;
let currentCharIndex = 0; // 청크 내 현재 문자 위치
let isSequential = true; // 정주행 기능 상태 (기본값: true)
let wakeLock = null; // Wake Lock 객체
let noSleep = null; // NoSleep.js 객체
let isRightPanelOpen = false; // 우측 패널 토글 상태 추가

// Web Speech API 객체
const synth = window.speechSynthesis;
let currentUtterance = null; // 현재 발화 중인 SpeechSynthesisUtterance 객체
let isPaused = false;
let isSpeaking = false;
let isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;


// --- DOM 요소 참조 ---
const fileInput = document.getElementById('file-input');
const dropArea = document.getElementById('drop-area');
const fileList = document.getElementById('file-list');
const voiceSelect = document.getElementById('voice-select');
const rateSlider = document.getElementById('rate-slider');
const rateDisplay = document.getElementById('rate-display');
const playPauseBtn = document.getElementById('play-pause-btn');
const stopBtn = document.getElementById('stop-btn');
const prevFileBtn = document.getElementById('prev-file-btn');
const nextFileBtn = document.getElementById('next-file-btn');
const sequentialReadCheckbox = document.getElementById('sequential-read-checkbox');
const clearAllFilesBtn = document.getElementById('clear-all-files-btn');
const textViewer = document.getElementById('text-viewer');
const mobileFileUploadBtn = document.getElementById('mobile-file-upload-btn');
const mobileLoadVoiceBtn = document.getElementById('mobile-load-voice-btn');

// 토글 버튼 DOM 참조 추가
const container = document.querySelector('.container');
const pcToggleBtn = document.getElementById('pc-toggle-btn');
const mobileToggleBtn = document.getElementById('mobile-toggle-btn');


// --- 유틸리티 함수 ---

/**
 * 상태 변경 시 컨테이너의 클래스를 업데이트하고 모바일 버튼 텍스트를 변경합니다.
 * @param {boolean} open 패널을 열지 닫을지 여부
 */
function updatePanelState(open) {
    isRightPanelOpen = open;
    container.classList.toggle('panel-expanded', open);
    container.classList.toggle('panel-collapsed', !open);
    
    if (isMobile) {
        mobileToggleBtn.textContent = open ? 'Right Panel 닫기' : 'Right Panel 열기';
    } else {
        // PC 모드에서는 아이콘 회전은 CSS에서 처리됩니다.
        pcToggleBtn.title = open ? 'Right Panel 닫기' : 'Right Panel 열기';
    }
}

/**
 * 우측 패널의 표시 상태를 토글합니다. (PC/Mobile 공용)
 */
function toggleRightPanel() {
    updatePanelState(!isRightPanelOpen);
}

// --- 이벤트 리스너 및 초기화 ---

/**
 * 초기화 함수
 */
function initialize() {
    // Web Speech API 관련 설정
    if (synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = populateVoiceList;
    }
    populateVoiceList();

    // DOM 이벤트 리스너 설정
    setupEventListeners();
    
    // 모바일 여부 확인 및 초기 패널 상태 설정
    // isMobile은 전역 변수로 이미 설정됨

    // 패널 초기 상태 설정 (기본적으로 닫힌 상태)
    updatePanelState(false); 

    // Wake Lock 초기화 (브라우저에서 지원하는 경우)
    if ('wakeLock' in navigator) {
        requestWakeLock();
    } else {
        // NoSleep.js를 대체제로 사용
        noSleep = new NoSleep();
    }

    // 북마크 로드 및 복원 시도
    loadBookmark();
}

/**
 * 음성 목록을 <select> 요소에 채웁니다.
 */
function populateVoiceList() {
    voiceSelect.innerHTML = '';
    const voices = synth.getVoices().filter(voice => voice.lang.startsWith('ko') || voice.lang.startsWith('en')); // 한국어/영어 필터링
    
    voices.forEach((voice, index) => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang}) ${voice.default ? ' - 기본' : ''}`;
        option.value = voice.name;
        
        // 기본값 설정 로직 (선호하는 언어의 첫 번째 또는 'Google' 음성)
        if (voice.default) {
            option.setAttribute('selected', 'selected');
        } else if (voice.name.includes('Google') && voice.lang.startsWith('ko') && !voiceSelect.querySelector('[selected]')) {
            option.setAttribute('selected', 'selected');
        }
        
        voiceSelect.appendChild(option);
    });

    // 선택된 음성이 없으면(목록이 비어있으면), 브라우저 기본 음성을 사용
    if (voices.length === 0) {
        const option = document.createElement('option');
        option.textContent = '브라우저 기본 음성';
        option.value = '';
        voiceSelect.appendChild(option);
    }
}


/**
 * 모든 이벤트 리스너를 설정합니다.
 */
function setupEventListeners() {
    // 1. 파일 첨부 및 드래그 앤 드롭
    dropArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFiles);
    dropArea.addEventListener('dragover', highlightDropArea);
    dropArea.addEventListener('dragleave', unhighlightDropArea);
    dropArea.addEventListener('drop', handleDrop);

    // 2. 재생 컨트롤
    playPauseBtn.addEventListener('click', togglePlayback);
    stopBtn.addEventListener('click', stopReading);
    prevFileBtn.addEventListener('click', playPreviousFile);
    nextFileBtn.addEventListener('click', playNextFile);
    clearAllFilesBtn.addEventListener('click', clearAllFiles);
    sequentialReadCheckbox.addEventListener('change', (e) => isSequential = e.target.checked);

    // 3. 음성 설정
    rateSlider.addEventListener('input', updateRateDisplay);
    voiceSelect.addEventListener('change', () => {
        // 음성 변경 시 재생 중이면, 현재 청크부터 다시 시작
        if (isSpeaking) {
            startReadingFromCurrentChunk(true);
        }
    });

    // 4. 모바일 버튼
    mobileFileUploadBtn.addEventListener('click', () => fileInput.click());
    mobileLoadVoiceBtn.addEventListener('click', populateVoiceList);
    
    // 5. 우측 패널 토글 버튼 리스너 추가
    pcToggleBtn.addEventListener('click', toggleRightPanel);
    mobileToggleBtn.addEventListener('click', toggleRightPanel);

    // 6. 텍스트 뷰어 (수정 시점 저장)
    textViewer.addEventListener('blur', saveCurrentTextViewerContent);

    // 7. 창 크기 변경 감지
    window.addEventListener('resize', handleResize);
}

/**
 * 창 크기 변경 시 모바일 상태를 업데이트합니다.
 */
function handleResize() {
    const wasMobile = isMobile;
    isMobile = window.innerWidth < 768;
    
    // 모바일 상태가 변경되었을 때만 패널 상태를 재설정 (버튼 표시/숨김)
    if (wasMobile !== isMobile) {
        updatePanelState(isRightPanelOpen);
    }
}

/**
 * 드래그 영역 하이라이트
 */
function highlightDropArea(e) {
    e.preventDefault();
    dropArea.classList.add('highlight');
}

/**
 * 드래그 영역 하이라이트 해제
 */
function unhighlightDropArea(e) {
    e.preventDefault();
    dropArea.classList.remove('highlight');
}

// ... (handleDrop, handleFiles, processFile, renderFileList, renderTextViewer, 
//      processTextFile, processExcelFile, processPdfFile, processImageFile, 
//      startReadingFromCurrentChunk, togglePlayback, stopReading, 
//      speakChunk, handleEndSpeech, updateRateDisplay, saveBookmark, loadBookmark, 
//      saveCurrentTextViewerContent, playFileAtIndex, playPreviousFile, playNextFile, 
//      clearAllFiles, removeFile, requestWakeLock, releaseWakeLock, 
//      scrollToHighlight, base64ToArrayBuffer, pcmToWav) 
//     ... 나머지 기존 함수들은 그대로 유지됩니다.

/**
 * 파일을 드롭했을 때 처리합니다.
 */
function handleDrop(e) {
    e.preventDefault();
    dropArea.classList.remove('highlight');
    if (e.dataTransfer.items) {
        [...e.dataTransfer.items].forEach((item) => {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                addFile(file);
            } else if (item.kind === 'string') {
                item.getAsString(s => {
                    if (s.length > 0) {
                        handlePastedText(s);
                    }
                });
            }
        });
    } else {
        [...e.dataTransfer.files].forEach((file) => {
            addFile(file);
        });
    }
}

/**
 * 파일 입력창에서 파일을 선택했을 때 처리합니다.
 */
function handleFiles(e) {
    [...e.target.files].forEach(file => addFile(file));
    e.target.value = null; // 동일 파일 재선택을 위해 초기화
}

/**
 * 텍스트나 URL을 붙여넣었을 때 처리합니다.
 */
function handlePastedText(text) {
    const trimmedText = text.trim();
    if (trimmedText.length === 0) return;

    // URL을 파일로 취급하여 처리 (파일 목록에 추가)
    if (URL_PATTERN.test(trimmedText)) {
        addFile(new File([trimmedText], `URL_${Date.now()}.txt`, { type: 'text/plain' }), true);
    } else {
        // 일반 텍스트를 파일로 취급하여 처리
        addFile(new File([trimmedText], `Clipboard_${Date.now()}.txt`, { type: 'text/plain' }), true);
    }
}

/**
 * 파일 데이터를 filesData 배열에 추가하고 렌더링합니다.
 * @param {File} file - 추가할 File 객체
 * @param {boolean} isPasted - 붙여넣기된 텍스트/URL인지 여부
 */
function addFile(file, isPasted = false) {
    if (filesData.length >= MAX_FILES) {
        console.error(`최대 파일 개수(${MAX_FILES}개)를 초과했습니다.`);
        return;
    }
    
    if (file.type === '' && file.name.endsWith('.pdf')) {
        file.type = 'application/pdf'; // PDF 파일 타입이 비어있는 경우 처리
    }
    
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    
    if (extension === '.txt' && file.size === 0 && !isPasted) {
        console.warn('빈 텍스트 파일은 무시됩니다.');
        return;
    }

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        console.error(`지원하지 않는 파일 형식입니다: ${extension}`);
        return;
    }
    
    const isImage = IMAGE_EXTENSIONS.includes(extension);
    const isXlsx = ['.xlsx', '.xls', '.csv'].includes(extension);
    const isPdf = extension === '.pdf';
    
    const newFile = {
        id: Date.now() + Math.random(),
        name: file.name,
        fullText: isImage || isPdf ? '' : null, // 텍스트 파일 외에는 처음에는 비워둠
        fileObject: file,
        isImage: isImage,
        isPdf: isPdf,
        isXlsx: isXlsx,
        chunks: [],
        isProcessed: false,
        isOcrProcessing: false, // OCR 처리 상태
        fileTypeIcon: isImage ? '🖼️' : (isPdf ? '📄' : (isXlsx ? '📊' : '📜'))
    };

    filesData.push(newFile);
    renderFileList();

    // 새 파일이 추가되면 자동으로 현재 파일로 설정하고 처리 시작
    currentFileIndex = filesData.length - 1;
    processFile(currentFileIndex);
}

/**
 * 특정 인덱스의 파일을 처리합니다 (텍스트 로드, OCR, 청크 나누기).
 * @param {number} index - filesData 내 파일 인덱스
 * @param {boolean} resume - 북마크에서 이어서 시작하는 경우
 */
function processFile(index, resume = false) {
    const fileItem = filesData[index];

    if (!fileItem || fileItem.isProcessed) return;

    // FileReader를 사용하여 파일 콘텐츠 읽기
    const reader = new FileReader();

    reader.onload = async (e) => {
        const extension = fileItem.name.substring(fileItem.name.lastIndexOf('.')).toLowerCase();
        let content = e.target.result;
        
        // 엑셀/CSV 파일 처리
        if (fileItem.isXlsx) {
            // 파일 내용을 base64로 저장
            gk_fileData[fileItem.name] = e.target.result.split(',')[1];
            gk_isXlsx = true;
            gk_xlsxFileLookup[fileItem.name] = true;
            
            // loadFileData 함수를 사용하여 내용 추출
            content = loadFileData(fileItem.name); 

            if (typeof content !== 'string') {
                content = '엑셀 파일 내용을 읽을 수 없습니다.';
            }
        } 
        // PDF 파일 처리
        else if (fileItem.isPdf) {
            try {
                content = await processPdfFile(e.target.result, fileItem);
            } catch (error) {
                content = `PDF 파일을 처리할 수 없습니다: ${error.message}`;
            }
        }
        // 이미지 파일 처리 (OCR)
        else if (fileItem.isImage) {
            fileItem.isOcrProcessing = true;
            renderFileList();
            try {
                content = await processImageFile(fileItem.fileObject);
            } catch (error) {
                content = `OCR 처리 중 오류가 발생했습니다: ${error.message}`;
            } finally {
                fileItem.isOcrProcessing = false;
            }
        }
        // 일반 텍스트 파일 처리
        else {
            content = e.target.result;
        }

        fileItem.fullText = content;
        
        // 청크 나누기
        fileItem.chunks = createChunks(fileItem.fullText);
        fileItem.isProcessed = true;
        
        renderFileList();
        
        if (currentFileIndex === index) {
            renderTextViewer(currentFileIndex);
            if (resume) {
                startReadingFromCurrentChunk(false); // 이어읽기 시작
            }
        }
    };

    // 파일 타입에 따라 읽는 방식 결정
    if (fileItem.isImage || fileItem.isPdf) {
        reader.readAsArrayBuffer(fileItem.fileObject);
    } else if (fileItem.isXlsx) {
        // XLSX는 Base64로 읽어야 SheetJS가 처리하기 편함
        reader.readAsDataURL(fileItem.fileObject);
    } else {
        // 일반 텍스트는 텍스트로 읽기
        reader.readAsText(fileItem.fileObject, 'UTF-8');
    }
}

/**
 * 텍스트를 청크로 나눕니다.
 * @param {string} text - 전체 텍스트
 * @returns {string[]} 청크 배열
 */
function createChunks(text) {
    if (!text) return ['텍스트가 없습니다.'];
    const chunks = [];
    let currentPos = 0;
    while (currentPos < text.length) {
        let endPos = currentPos + CHUNK_SIZE_LIMIT;
        
        // 청크 크기 제한을 초과하지 않는 선에서 마침표/문장 끝 찾기
        if (endPos < text.length) {
            const boundary = text.substring(currentPos, endPos).lastIndexOf(/[\.\?!:;\n]/);
            if (boundary !== -1 && boundary > CHUNK_SIZE_LIMIT * 0.8) {
                endPos = currentPos + boundary + 1;
            }
        }
        
        chunks.push(text.substring(currentPos, endPos).trim());
        currentPos = endPos;
    }
    return chunks.filter(chunk => chunk.length > 0);
}


/**
 * 파일 목록을 렌더링합니다.
 */
function renderFileList() {
    fileList.innerHTML = '';
    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.index = index;
        li.className = index === currentFileIndex ? 'current-file' : '';
        
        const fileNameSpan = document.createElement('span');
        fileNameSpan.textContent = `${file.fileTypeIcon} ${file.name}`;
        
        const statusContainer = document.createElement('div');
        statusContainer.style.display = 'flex';
        statusContainer.style.alignItems = 'center';

        if (file.isOcrProcessing) {
            fileNameSpan.textContent = `${file.fileTypeIcon} ${file.name} (OCR 처리 중...)`;
            const spinner = document.createElement('span');
            spinner.className = 'ocr-status';
            spinner.textContent = '🔄'; // 회전 아이콘
            statusContainer.appendChild(spinner);
        } else if (file.isProcessed) {
             const statusSpan = document.createElement('span');
             statusSpan.className = 'ocr-status';
             statusSpan.textContent = '✔️'; // 완료 아이콘
             statusContainer.appendChild(statusSpan);
        }

        // 삭제 버튼
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '❌';
        deleteBtn.title = '파일 삭제';
        deleteBtn.onclick = (e) => {
            e.stopPropagation(); // li 클릭 이벤트 방지
            removeFile(index);
        };

        li.appendChild(fileNameSpan);
        li.appendChild(statusContainer);
        li.appendChild(deleteBtn);
        
        li.onclick = () => playFileAtIndex(index);
        
        fileList.appendChild(li);
    });
}

/**
 * 텍스트 뷰어에 현재 파일의 내용을 렌더링합니다.
 * @param {number} index - filesData 내 파일 인덱스
 */
function renderTextViewer(index) {
    if (index < 0 || index >= filesData.length) {
        textViewer.innerHTML = '<p>파일을 선택하거나 내용을 입력하세요.</p>';
        textViewer.contentEditable = 'true';
        return;
    }
    
    const file = filesData[index];
    
    if (!file.isProcessed) {
        textViewer.innerHTML = `<p>${file.name} 파일을 처리 중입니다...${file.isOcrProcessing ? ' (OCR 진행 중)' : ''}</p>`;
        textViewer.contentEditable = 'false';
        return;
    }

    // 청크를 사용하여 가상화된 텍스트 렌더링
    const start = Math.max(0, currentChunkIndex - Math.floor(VISIBLE_CHUNKS / 2));
    const end = Math.min(file.chunks.length, start + VISIBLE_CHUNKS);

    let html = '';
    for (let i = 0; i < file.chunks.length; i++) {
        const chunkText = file.chunks[i];
        
        // 현재 청크만 렌더링에 포함
        if (i >= start && i < end) {
             let chunkHtml = `<span data-chunk-index="${i}">${chunkText}</span>`;
            
            // 현재 발화 중인 청크 하이라이트
            if (i === currentChunkIndex && isSpeaking) {
                // 현재 문자에 대한 하이라이트 (현재는 문자 인덱스 미사용)
                let highlightedText = chunkText;
                
                // 현재 문자 위치 하이라이트 (시작 시)
                if (currentCharIndex > 0 && currentCharIndex < chunkText.length) {
                    highlightedText = 
                        chunkText.substring(0, currentCharIndex) + 
                        `<span class="highlight-char">${chunkText.charAt(currentCharIndex)}</span>` + 
                        chunkText.substring(currentCharIndex + 1);
                } else if (currentCharIndex >= chunkText.length) {
                    // 마지막 문자 처리 (예외 방지)
                     highlightedText = chunkText;
                }
                
                chunkHtml = `<span data-chunk-index="${i}" class="highlight-chunk">${highlightedText}</span>`;
            }
            
            html += chunkHtml + (chunkText.endsWith('\n') ? '' : '<br><br>');
        } else if (i === start && start > 0) {
            // 이전 내용이 있음을 알림
            html = `<p class="placeholder-text">[... 이전 ${start}개의 청크 생략 ...] <button onclick="scrollToChunk(${Math.max(0, start - VISIBLE_CHUNKS)})">위로 이동</button></p>` + html;
        } else if (i === end - 1 && end < file.chunks.length) {
            // 이후 내용이 있음을 알림
            html += `<p class="placeholder-text"><button onclick="scrollToChunk(${end})">아래로 이동</button> [... 이후 ${file.chunks.length - end}개의 청크 생략 ...]</p>`;
        }
    }
    
    textViewer.innerHTML = html;
    textViewer.contentEditable = 'true';
    scrollToHighlight(); // 하이라이트된 청크로 스크롤 이동
}

/**
 * 텍스트 뷰어에서 현재 하이라이트된 청크로 스크롤합니다.
 */
function scrollToHighlight() {
    const highlightedChunk = textViewer.querySelector('.highlight-chunk');
    if (highlightedChunk) {
        highlightedChunk.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}


/**
 * 임시: 가상화된 텍스트 뷰어에서 지정된 청크 인덱스로 이동합니다.
 * @param {number} index - 이동할 청크 인덱스
 */
function scrollToChunk(index) {
    if (index >= 0 && index < filesData[currentFileIndex].chunks.length) {
        currentChunkIndex = index;
        renderTextViewer(currentFileIndex);
        scrollToHighlight();
    }
}


/**
 * 현재 청크부터 재생을 시작합니다.
 * @param {boolean} forceStopAndStart - 기존 재생을 강제로 멈추고 새로 시작할지 여부
 */
function startReadingFromCurrentChunk(forceStopAndStart = false) {
    if (forceStopAndStart) {
        stopReading();
    } else if (isSpeaking && !isPaused) {
        return; // 이미 재생 중이면 무시
    }
    
    if (currentFileIndex === -1 || !filesData[currentFileIndex].isProcessed || currentChunkIndex >= filesData[currentFileIndex].chunks.length) {
        // 파일이 없거나, 처리되지 않았거나, 마지막 청크를 넘었을 때
        stopReading();
        return;
    }
    
    isSpeaking = true;
    isPaused = false;
    requestWakeLock(); // 재생 시작 시 Wake Lock 요청
    playPauseBtn.textContent = '⏸️'; // 아이콘 변경
    
    speakChunk(currentFileIndex, currentChunkIndex);
    renderTextViewer(currentFileIndex); // 현재 청크 하이라이트
    saveBookmark(); // 북마크 저장
}

/**
 * 재생을 토글합니다 (재생/일시정지).
 */
function togglePlayback() {
    if (isSpeaking) {
        if (isPaused) {
            synth.resume();
            isPaused = false;
            playPauseBtn.textContent = '⏸️';
            requestWakeLock();
        } else {
            synth.pause();
            isPaused = true;
            playPauseBtn.textContent = '▶️';
            releaseWakeLock();
        }
    } else {
        // 재생 중이 아닐 때 (처음 시작하거나 완전히 멈췄을 때)
        if (currentFileIndex === -1 && filesData.length > 0) {
            currentFileIndex = 0;
            currentChunkIndex = 0;
            currentCharIndex = 0;
            if (!filesData[currentFileIndex].isProcessed) {
                processFile(currentFileIndex); // 처리되지 않았으면 처리 시작
            }
        }
        startReadingFromCurrentChunk();
    }
    renderTextViewer(currentFileIndex); // 하이라이트 업데이트
}

/**
 * 재생을 완전히 멈춥니다.
 */
function stopReading() {
    if (synth.speaking) {
        synth.cancel();
    }
    isSpeaking = false;
    isPaused = false;
    playPauseBtn.textContent = '▶️';
    releaseWakeLock(); // 재생 종료 시 Wake Lock 해제
    
    // 마지막 청크 하이라이트 해제
    renderTextViewer(currentFileIndex); 
}

/**
 * 특정 청크를 발화합니다.
 * @param {number} fileIndex - 파일 인덱스
 * @param {number} chunkIndex - 청크 인덱스
 */
function speakChunk(fileIndex, chunkIndex) {
    stopReading(); // 현재 발화 중인 것을 중단 (cancel)
    
    const file = filesData[fileIndex];
    if (!file || !file.isProcessed || chunkIndex >= file.chunks.length) {
        handleEndSpeech();
        return;
    }
    
    currentFileIndex = fileIndex;
    currentChunkIndex = chunkIndex;
    currentCharIndex = 0; // 청크가 바뀔 때 문자 위치 초기화
    
    const chunkText = file.chunks[chunkIndex];
    currentUtterance = new SpeechSynthesisUtterance(chunkText);
    
    // 음성 및 속도 설정
    const selectedVoiceName = voiceSelect.value;
    const voice = synth.getVoices().find(v => v.name === selectedVoiceName) || synth.getVoices()[0];
    currentUtterance.voice = voice;
    currentUtterance.rate = parseFloat(rateSlider.value);
    
    currentUtterance.onend = handleEndSpeech;
    currentUtterance.onerror = (event) => {
        console.error('SpeechSynthesisUtterance.onerror', event);
        handleEndSpeech(); // 에러 발생 시 다음 청크로 이동 시도
    };
    
    currentUtterance.onboundary = (event) => {
        if (event.name === 'word' || event.name === 'sentence') {
            // 현재 문자 위치를 업데이트하여 하이라이트를 실시간으로 업데이트 (성능 문제로 임시 주석처리)
            // currentCharIndex = event.charIndex;
            // renderTextViewer(currentFileIndex);
        }
    };

    synth.speak(currentUtterance);
    renderTextViewer(currentFileIndex); // 청크가 바뀔 때 뷰어 갱신
    saveBookmark(); // 북마크 저장
}

/**
 * 청크 발화가 끝났을 때 처리합니다.
 */
function handleEndSpeech() {
    if (isPaused) return; // 일시 정지 중이었다면 무시
    
    const file = filesData[currentFileIndex];
    if (!file) {
        stopReading();
        return;
    }

    if (currentChunkIndex < file.chunks.length - 1) {
        // 다음 청크 재생
        speakChunk(currentFileIndex, currentChunkIndex + 1);
    } else {
        // 파일 끝 도달
        if (isSequential && currentFileIndex < filesData.length - 1) {
            // 정주행 모드이고 다음 파일이 있으면 다음 파일 재생
            playNextFile();
        } else {
            // 재생 완전히 종료
            stopReading();
        }
    }
}

/**
 * 재생 속도 슬라이더의 값을 표시합니다.
 */
function updateRateDisplay(e) {
    rateDisplay.textContent = e.target.value;
    // 속도 변경 시 재생 중이면, 현재 청크부터 다시 시작
    if (isSpeaking && currentUtterance) {
        currentUtterance.rate = parseFloat(e.target.value);
        if (!isPaused) {
             startReadingFromCurrentChunk(true); 
        }
    }
}

/**
 * 현재 상태를 로컬 스토리지에 북마크합니다.
 */
function saveBookmark() {
    if (currentFileIndex === -1 || !filesData[currentFileIndex].isProcessed) return;

    const bookmark = {
        currentFileIndex: currentFileIndex,
        chunkIndex: currentChunkIndex,
        rate: parseFloat(rateSlider.value),
        voiceName: voiceSelect.value,
        isSequential: isSequential,
        files: filesData.map(file => ({
            id: file.id,
            name: file.name,
            fullText: file.fullText, // 텍스트만 저장
            isImage: file.isImage,
            isPdf: file.isPdf,
            isXlsx: file.isXlsx,
            isProcessed: file.isProcessed,
            chunks: file.chunks // 청크 데이터도 저장
        }))
    };
    localStorage.setItem('audiobookMakerBookmark', JSON.stringify(bookmark));
}

/**
 * 로컬 스토리지에서 북마크를 로드하고 복원합니다.
 */
function loadBookmark() {
    const bookmarkString = localStorage.getItem('audiobookMakerBookmark');
    if (!bookmarkString) return;
    
    try {
        const bookmark = JSON.parse(bookmarkString);

        // 1. 설정 복원
        rateSlider.value = bookmark.rate || 1;
        rateDisplay.textContent = bookmark.rate || 1;
        sequentialReadCheckbox.checked = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
        isSequential = sequentialReadCheckbox.checked;

        // 음성 복원은 populateVoiceList 이후에 시도
        const voiceOption = voiceSelect.querySelector(`option[value="${bookmark.voiceName}"]`);
        if (voiceOption) {
            voiceOption.selected = true;
        }

        // 2. 파일 목록 복원
        if (bookmark.files && bookmark.files.length > 0) {
            filesData = bookmark.files.map(file => {
                // fullText와 chunks가 있는 경우 isProcessed를 true로 설정
                const isProcessed = !!(file.fullText || file.chunks?.length > 0);
                return {
                    ...file,
                    fileObject: null, // File 객체는 복원 불가능
                    isProcessed: isProcessed, // 복원된 데이터 기준으로 처리 상태 설정
                    isOcrProcessing: false // 복원 시 OCR 상태 초기화
                };
            });
            
            renderFileList(); 

            // 3. 이어듣기 프롬프트 및 재생 시작 (confirm() 제거)
            const fileToResume = filesData[bookmark.currentFileIndex];
            if (fileToResume) {
                // confirm() 대신 사용자에게 안내만 하고, 버튼 클릭 시 재생 시작하도록 유도
                console.log(`[북마크] 지난번 읽던 파일: "${fileToResume.name}"의 ${bookmark.chunkIndex + 1}번째 부분부터 이어서 들을 수 있습니다. '▶️' 버튼을 눌러 시작하세요.`);

                currentFileIndex = bookmark.currentFileIndex;
                currentChunkIndex = bookmark.chunkIndex;
                currentCharIndex = 0; 
                
                if (!fileToResume.isProcessed && (fileToResume.isImage || fileToResume.isPdf)) {
                    // 복원된 파일이 미처리 상태인 경우 (예: OCR이 필요한 이미지)
                    // 실제 File 객체가 없으므로, 재처리할 수 없음. 사용자에게 재업로드 안내
                    console.error('이미지/PDF 파일은 File 객체 없이는 복원할 수 없습니다. 재업로드 해주세요.');
                    filesData[currentFileIndex].fullText = `[복원 오류] ${fileToResume.name}: 원본 파일이 없으므로 OCR/PDF 처리를 재시작할 수 없습니다. 파일을 다시 첨부해 주세요.`;
                    filesData[currentFileIndex].isProcessed = true;
                    currentChunkIndex = 0;
                    filesData[currentFileIndex].chunks = createChunks(filesData[currentFileIndex].fullText);
                    renderTextViewer(currentFileIndex);
                } else {
                    // 텍스트/엑셀 파일이거나 이미 청크까지 처리된 경우
                    renderTextViewer(currentFileIndex);
                    // startReadingFromCurrentChunk(); // 자동 재생은 하지 않음
                }
                
                renderFileList(); 
                
            } else {
                // 파일 목록은 유지하되, 현재 인덱스는 초기화
                currentFileIndex = 0;
                currentChunkIndex = 0;
                currentCharIndex = 0;
                if (filesData.length > 0) {
                     renderTextViewer(currentFileIndex);
                } else {
                    renderTextViewer(-1);
                }
            }
            
        } else {
            // 파일 목록이 없으면 초기화
            localStorage.removeItem('audiobookMakerBookmark');
            renderTextViewer(-1);
        }
        
    } catch (e) {
        console.error('북마크 로드 중 오류 발생:', e);
        localStorage.removeItem('audiobookMakerBookmark');
    }
}


/**
 * 텍스트 뷰어의 현재 내용을 저장합니다 (사용자 직접 수정 시).
 */
function saveCurrentTextViewerContent() {
    if (currentFileIndex === -1) return;

    const file = filesData[currentFileIndex];
    if (!file || !textViewer.textContent) return;

    // 뷰어 내용을 새 fullText로 저장
    const newFullText = textViewer.textContent.trim();
    if (newFullText !== file.fullText?.trim()) {
        file.fullText = newFullText;
        file.chunks = createChunks(newFullText);
        file.isProcessed = true;
        currentChunkIndex = 0;
        currentCharIndex = 0;
        
        // 재생 중이었다면 새로 시작
        if (isSpeaking) {
            startReadingFromCurrentChunk(true); 
        } else {
            renderTextViewer(currentFileIndex);
        }
        saveBookmark();
        console.log('텍스트 뷰어 내용이 업데이트 및 저장되었습니다.');
    }
}

/**
 * 특정 인덱스의 파일을 재생 목록에서 제거합니다.
 * @param {number} index - filesData 내 파일 인덱스
 */
function removeFile(index) {
    if (index < 0 || index >= filesData.length) return;

    const fileToRemove = filesData[index];
    const isCurrentlyPlaying = (index === currentFileIndex && isSpeaking);

    // 재생 중인 파일이었다면 중단
    if (isCurrentlyPlaying) {
        stopReading();
    }

    // 배열에서 파일 제거
    filesData.splice(index, 1);
    
    // 현재 인덱스 조정
    if (currentFileIndex === index) {
        // 제거된 파일이 현재 파일이었다면 다음 파일로 이동하거나 -1로 설정
        currentFileIndex = (filesData.length > 0) ? Math.min(index, filesData.length - 1) : -1;
        currentChunkIndex = 0;
        currentCharIndex = 0;
    } else if (currentFileIndex > index) {
        // 현재 파일보다 앞에 있는 파일이 제거되면 현재 인덱스 감소
        currentFileIndex--;
    }
    
    // 텍스트 뷰어 및 파일 목록 갱신
    renderFileList();
    renderTextViewer(currentFileIndex);
    saveBookmark();
}


/**
 * 특정 인덱스의 파일을 선택하고 재생을 시작합니다.
 * @param {number} index - filesData 내 파일 인덱스
 */
function playFileAtIndex(index) {
    if (index < 0 || index >= filesData.length) return;

    stopReading();
    currentFileIndex = index;
    currentChunkIndex = 0;
    currentCharIndex = 0;
    
    const file = filesData[index];
    if (!file.isProcessed) {
        processFile(index); // 처리되지 않았으면 처리 시작
    } else {
        renderTextViewer(index);
    }
    
    renderFileList();
    // startReadingFromCurrentChunk(); // 자동 재생은 하지 않음
    saveBookmark();
}

/**
 * 이전 파일을 재생합니다.
 */
function playPreviousFile() {
    if (currentFileIndex > 0) {
        playFileAtIndex(currentFileIndex - 1);
    } else {
        // 처음 파일에서 이전 버튼을 누르면 정지
        stopReading();
    }
}

/**
 * 다음 파일을 재생합니다.
 */
function playNextFile() {
    if (currentFileIndex < filesData.length - 1) {
        playFileAtIndex(currentFileIndex + 1);
    } else {
        // 마지막 파일에서 다음 버튼을 누르면 정지
        stopReading();
    }
}

/**
 * 모든 파일을 제거합니다.
 */
function clearAllFiles() {
    // confirm() 대신 console.log() 사용
    if (filesData.length === 0) {
        console.log('삭제할 파일이 없습니다.');
        return;
    }

    console.log('모든 파일이 삭제되었습니다.');
    stopReading();
    filesData = [];
    currentFileIndex = -1;
    currentChunkIndex = 0;
    currentCharIndex = 0;
    localStorage.removeItem('audiobookMakerBookmark');
    renderFileList();
    renderTextViewer(-1);
    
    // 엑셀 관련 전역 변수 초기화
    gk_isXlsx = false;
    gk_xlsxFileLookup = {};
    gk_fileData = {};
}

// PDF 파일을 ArrayBuffer로 처리하여 텍스트를 추출합니다.
async function processPdfFile(arrayBuffer, fileItem) {
    let pdfText = '';
    
    try {
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        
        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            
            // 텍스트 콘텐츠의 item들을 줄 바꿈으로 연결
            const pageText = textContent.items.map(item => item.str).join(' ');
            pdfText += pageText + '\n\n'; // 페이지 구분을 위해 두 번 줄바꿈
        }
        
        return pdfText.trim();
    } catch (error) {
        console.error(`PDF 처리 오류: ${error.message}`);
        throw new Error('PDF 파일을 읽는 중 오류가 발생했습니다.');
    }
}

// 이미지 파일을 OCR로 처리하여 텍스트를 추출합니다.
async function processImageFile(fileObject) {
    let ocrText = '';
    
    try {
        const { data: { text } } = await Tesseract.recognize(
            fileObject,
            'kor+eng', // 한국어와 영어 동시 인식
            { logger: m => console.log(m) } // 콘솔에 진행 상황 로깅
        );
        ocrText = text;
        return ocrText.trim();
    } catch (error) {
        console.error(`OCR 처리 오류: ${error.message}`);
        throw new Error('OCR 엔진 처리 중 오류가 발생했습니다.');
    }
}


// --- Wake Lock 기능 ---

/**
 * Wake Lock을 요청합니다 (화면 꺼짐 방지).
 */
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock이 해제되었습니다.');
            });
            console.log('Wake Lock이 활성화되었습니다.');
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
            // Wake Lock이 실패하면 NoSleep.js 활성화 시도
            if (noSleep) {
                noSleep.enable();
                console.log('NoSleep.js가 활성화되었습니다.');
            }
        }
    } else if (noSleep) {
        // navigator.wakeLock이 지원되지 않으면 NoSleep.js 활성화 시도
        noSleep.enable();
        console.log('NoSleep.js가 활성화되었습니다.');
    }
}

/**
 * Wake Lock을 해제합니다.
 */
function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release()
            .then(() => {
                wakeLock = null;
                console.log('Wake Lock이 해제되었습니다.');
            });
    } else if (noSleep && noSleep.enabled) {
        noSleep.disable();
        console.log('NoSleep.js가 비활성화되었습니다.');
    }
}


/**
 * Base64 문자열을 ArrayBuffer로 변환
 * @param {string} base64 - Base64 인코딩된 문자열 (Data URL 포함 가능)
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
    let binary_string;
    if (base64.startsWith('data:')) {
        binary_string = atob(base64.split(',')[1]);
    } else {
        binary_string = atob(base64);
    }
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * PCM 데이터를 WAV 형식 Blob으로 변환
 * @param {Int16Array} pcmData - 16비트 PCM 데이터
 * @param {number} sampleRate - 샘플링 속도
 * @returns {Blob} WAV 파일 Blob
 */
function pcmToWav(pcmData, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    const buffer = new ArrayBuffer(44 + pcmData.byteLength);
    const view = new DataView(buffer);

    // RIFF identifier
    writeString(view, 0, 'RIFF');
    // RIFF chunk length
    view.setUint32(4, 36 + pcmData.byteLength, true);
    // WAV format identifier
    writeString(view, 8, 'WAVE');
    // fmt sub-chunk identifier
    writeString(view, 12, 'fmt ');
    // fmt sub-chunk length
    view.setUint32(16, 16, true);
    // Audio format (1 for PCM)
    view.setUint16(20, 1, true);
    // Number of channels
    view.setUint16(22, numChannels, true);
    // Sample rate
    view.setUint32(24, sampleRate, true);
    // Byte rate
    view.setUint32(28, byteRate, true);
    // Block align
    view.setUint16(32, blockAlign, true);
    // Bits per sample
    view.setUint16(34, bitsPerSample, true);
    // data sub-chunk identifier
    writeString(view, 36, 'data');
    // data sub-chunk length
    view.setUint32(40, pcmData.byteLength, true);

    // Write PCM data
    let offset = 44;
    for (let i = 0; i < pcmData.length; i++, offset += 2) {
        view.setInt16(offset, pcmData[i], true);
    }

    return new Blob([view], { type: 'audio/wav' });
}

/**
 * DataView에 문자열을 기록하는 헬퍼 함수
 */
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// 애플리케이션 시작
document.addEventListener('DOMContentLoaded', initialize);
