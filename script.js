// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/([^\\s$.?#].[^\\s]*)$/i; // URL 인식 패턴

// --- 파일 관련 상수 추가 ---
const TEXT_EXTENSIONS = ['.txt'];
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
let isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);

// --- DOM 요소 캐싱 ---
const $audiobookApp = document.getElementById('audiobook-app');
const $dropArea = document.getElementById('full-screen-drop-area');
const $textViewer = document.getElementById('text-viewer');
const $fileList = document.getElementById('file-list');
const $voiceSelect = document.getElementById('voice-select');
const $rateSlider = document.getElementById('rate-slider');
const $rateDisplay = document.getElementById('rate-display');
const $playPauseBtn = document.getElementById('play-pause-btn');
const $stopBtn = document.getElementById('stop-btn');
const $prevChunkBtn = document.getElementById('prev-chunk-btn');
const $nextChunkBtn = document.getElementById('next-chunk-btn');
const $mobileFileUploadBtn = document.getElementById('mobile-file-upload-btn');
const $mobileLoadVoiceBtn = document.getElementById('mobile-load-voice-btn');
const $sequentialReadCheckbox = document.getElementById('sequential-read');

// 텍스트 뷰어 안내 문구 관리
const PLACEHOLDER_TEXT = '텍스트, 이미지 파일을 드래그하여 첨부하거나 텍스트/URL을 붙여넣어 오디오북으로 변환하세요! 모바일에선 파일첨부, 음성로드 버튼을 활용해주세요';
const PLACEHOLDER_HTML = `<p>${PLACEHOLDER_TEXT.replace(/\n/g, '<br>')}</p>`;

// --- 유틸리티 함수 ---
function debounce(func, timeout = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

function normalizeText(text) {
    // 텍스트에서 모든 공백과 줄바꿈을 제거하고 소문자로 변환하여 비교 용이하게 만듭니다.
    return text.replace(/[\s\n\r<br>]/g, '').toLowerCase();
}

/**
 * @description: 텍스트 뷰어의 안내 문구를 제거합니다.
 */
function removePlaceholder() {
    // 뷰어의 텍스트 콘텐츠를 정규화하여 안내 문구와 비교합니다.
    const normalizedContent = normalizeText($textViewer.innerHTML);
    const normalizedPlaceholder = normalizeText(PLACEHOLDER_TEXT);

    if (normalizedContent === normalizedPlaceholder) {
        $textViewer.innerHTML = '';
    }
}

/**
 * @description: 텍스트 뷰어가 비어있을 경우 안내 문구를 다시 표시합니다.
 */
function restorePlaceholder() {
    const content = $textViewer.innerText.trim();
    if (content === '') {
        $textViewer.innerHTML = PLACEHOLDER_HTML;
    }
}

// --- 이벤트 리스너 ---

/**
 * @description: 텍스트 뷰어에 포커스되었을 때 안내 문구를 제거합니다.
 */
$textViewer.addEventListener('focus', () => {
    removePlaceholder();
});

/**
 * @description: 텍스트 뷰어에서 포커스가 해제되었을 때 안내 문구를 복원합니다.
 */
$textViewer.addEventListener('blur', () => {
    restorePlaceholder();
    // Blur 발생 후 내용이 변경되었을 수 있으므로 파일 목록도 업데이트할 수 있습니다 (필요하다면).
    // updateFilesList();
});

// --- 기존의 나머지 함수들은 그대로 유지합니다 ---

function updateRateDisplay() {
    $rateDisplay.textContent = parseFloat($rateSlider.value).toFixed(1);
}

function populateVoiceList() {
    const voices = synth.getVoices().sort((a, b) => {
        const an = a.name.toUpperCase();
        const bn = b.name.toUpperCase();
        if (an < bn) return -1;
        if (an > bn) return +1;
        return 0;
    });

    const currentVoiceName = localStorage.getItem('selectedVoiceName');

    $voiceSelect.innerHTML = '';
    
    voices.forEach(voice => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang})`;
        option.setAttribute('data-lang', voice.lang);
        option.setAttribute('data-name', voice.name);
        option.value = voice.name;

        if (currentVoiceName && currentVoiceName === voice.name) {
            option.selected = true;
        } else if (!currentVoiceName && voice.default) {
            option.selected = true;
        }
        $voiceSelect.appendChild(option);
    });
}

function selectVoice(name) {
    const option = Array.from($voiceSelect.options).find(opt => opt.value === name);
    if (option) {
        $voiceSelect.value = name;
        localStorage.setItem('selectedVoiceName', name);
    }
}

// 음성 목록 로드 및 이벤트 리스너 설정
if (synth.onvoiceschanged !== undefined) {
    synth.onvoiceschanged = populateVoiceList;
} else {
    populateVoiceList();
}

$voiceSelect.addEventListener('change', () => {
    localStorage.setItem('selectedVoiceName', $voiceSelect.value);
});

$rateSlider.addEventListener('input', updateRateDisplay);

// Wake Lock API 및 NoSleep.js 처리 (화면 꺼짐 방지)
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
        }
    } else if (typeof NoSleep !== 'undefined') {
        noSleep = new NoSleep();
        noSleep.enable();
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release()
            .then(() => {
                wakeLock = null;
            });
    } else if (noSleep) {
        noSleep.disable();
        noSleep = null;
    }
}

// 텍스트를 청크로 분할
function chunkText(text) {
    // 텍스트를 문장이나 적절한 단위로 분할하되, CHUNK_SIZE_LIMIT를 넘지 않도록 합니다.
    const chunks = [];
    let currentChunk = '';

    // 문장 구분을 위한 정규 표현식 (마침표, 물음표, 느낌표 다음에 공백이나 줄바꿈)
    const sentences = text.match(/[^.?!]+[.?!]+|.+$/g) || [text];

    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > CHUNK_SIZE_LIMIT) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            // 문장 자체가 너무 길면 강제 분할
            let remaining = sentence.trim();
            while (remaining.length > CHUNK_SIZE_LIMIT) {
                chunks.push(remaining.substring(0, CHUNK_SIZE_LIMIT));
                remaining = remaining.substring(CHUNK_SIZE_LIMIT);
            }
            currentChunk = remaining;
        } else {
            currentChunk += ' ' + sentence;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(c => c.length > 0);
}

// OCR 처리 (미구현 상태)
async function processOcr(fileObject, fileId) {
    // TODO: 여기에 실제 OCR API 호출 로직을 구현합니다.
    // 현재는 더미 데이터로 처리합니다.
    return new Promise(resolve => {
        setTimeout(() => {
            console.log(`OCR Processing for fileId: ${fileId} (DUMMY)`);
            const dummyText = `파일 ${fileId} (${fileObject.name}) 의 OCR 결과입니다. 이 텍스트는 이미지에서 추출된 내용을 시뮬레이션합니다. 실제 서비스에서는 OCR 엔진을 사용해야 합니다.`;
            resolve(dummyText);
        }, 1500); // 1.5초 지연 시뮬레이션
    });
}

// 파일 데이터 구조 초기화/업데이트
async function updateFileData(fileId, update) {
    const fileIndex = filesData.findIndex(f => f.id === fileId);
    if (fileIndex !== -1) {
        const oldData = filesData[fileIndex];
        filesData[fileIndex] = { ...oldData, ...update };

        // 텍스트 파일이거나 OCR이 완료된 경우 청크 생성
        if (filesData[fileIndex].fullText && !filesData[fileIndex].isProcessed) {
            filesData[fileIndex].chunks = chunkText(filesData[fileIndex].fullText);
            filesData[fileIndex].isProcessed = true;
        }
        
        // 이미지 파일이고 OCR 처리가 필요한 경우
        if (filesData[fileIndex].isImage && !filesData[fileIndex].isOcrProcessing && !filesData[fileIndex].fullText) {
            filesData[fileIndex].isOcrProcessing = true;
            updateFilesList(); // 상태 업데이트
            try {
                const ocrText = await processOcr(filesData[fileIndex].fileObject, fileId);
                await updateFileData(fileId, { fullText: ocrText, isOcrProcessing: false, isProcessed: false });
            } catch (error) {
                console.error("OCR 처리 오류:", error);
                await updateFileData(fileId, { fullText: "OCR 처리 실패", isOcrProcessing: false, isProcessed: true, chunks: ["OCR 처리 실패"] });
            }
        }
    }
    updateFilesList();
}


// 파일 추가
async function addFile(file) {
    if (filesData.length >= MAX_FILES) {
        console.warn(`최대 파일 개수(${MAX_FILES}) 초과`);
        return;
    }

    const fileId = crypto.randomUUID();
    const fileName = file.name;
    const extension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    const isImage = IMAGE_EXTENSIONS.includes(extension);

    let newFile = {
        id: fileId,
        name: fileName,
        fileObject: file,
        isImage: isImage,
        fullText: null,
        chunks: [],
        isProcessed: false,
        isOcrProcessing: isImage ? false : false // 이미지 파일은 일단 OCR 처리 대기로 시작
    };
    
    filesData.push(newFile);
    updateFilesList();

    if (isImage) {
        // 이미지 파일은 OCR 처리 대기 상태로 시작
        await updateFileData(fileId, { isOcrProcessing: true });
    } else {
        // 텍스트 파일은 바로 내용 읽기
        const reader = new FileReader();
        reader.onload = async (e) => {
            await updateFileData(fileId, { fullText: e.target.result });
        };
        reader.onerror = () => {
            console.error("파일 읽기 오류:", fileName);
            updateFileData(fileId, { fullText: "파일을 읽을 수 없음" });
        };
        reader.readAsText(file);
    }

    if (currentFileIndex === -1) {
        setCurrentFile(filesData.length - 1);
    }
}

// URL/텍스트 붙여넣기 처리
function handlePastedContent(content) {
    const fileId = crypto.randomUUID();
    let fileName, fullText;

    if (URL_PATTERN.test(content)) {
        fileName = "URL_CONTENT.txt";
        fullText = `다음 URL에서 콘텐츠를 로드합니다: ${content}`;
        // 실제 URL 로드 로직 추가 필요
    } else {
        fileName = "Pasted_Text.txt";
        fullText = content;
    }

    const newFile = {
        id: fileId,
        name: fileName,
        fileObject: null,
        isImage: false,
        fullText: fullText,
        chunks: chunkText(fullText),
        isProcessed: true,
        isOcrProcessing: false
    };

    filesData.push(newFile);
    if (currentFileIndex === -1) {
        setCurrentFile(filesData.length - 1);
    } else {
        updateFilesList();
    }
}

// --- 파일 목록 UI 및 드래그 앤 드롭 ---

function handleDrop(e) {
    e.preventDefault();
    $dropArea.style.display = 'none';

    if (e.dataTransfer.items) {
        [...e.dataTransfer.items].forEach((item) => {
            if (item.kind === 'file') {
                const file = item.getAsFile();
                const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
                if (ALLOWED_EXTENSIONS.includes(extension)) {
                    addFile(file);
                } else {
                    console.warn(`지원하지 않는 파일 형식: ${file.name}`);
                }
            }
        });
    } else {
        [...e.dataTransfer.files].forEach((file) => {
            const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
            if (ALLOWED_EXTENSIONS.includes(extension)) {
                addFile(file);
            } else {
                    console.warn(`지원하지 않는 파일 형식: ${file.name}`);
                }
        });
    }
}

// 드래그 앤 드롭 이벤트 핸들러
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.some(t => t === 'Files' || t === 'text/plain')) {
        $dropArea.style.display = 'flex';
    }
});

$dropArea.addEventListener('dragleave', (e) => {
    // 드래그가 뷰포트 밖으로 나갔을 때만 숨기기
    if (e.clientX === 0 && e.clientY === 0) {
        $dropArea.style.display = 'none';
    }
});

$dropArea.addEventListener('drop', handleDrop);


// 파일 목록 업데이트 UI
function updateFilesList() {
    $fileList.innerHTML = '';
    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.fileIndex = index;
        li.dataset.fileId = file.id;

        const fileNameSpan = document.createElement('span');
        fileNameSpan.textContent = file.name;
        fileNameSpan.style.flexGrow = '1';

        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('file-controls');
        
        const dragHandle = document.createElement('span');
        dragHandle.classList.add('drag-handle');
        dragHandle.textContent = '☰';
        
        const deleteBtn = document.createElement('button');
        deleteBtn.classList.add('delete-file-btn');
        deleteBtn.textContent = '✖';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteFile(index);
        };

        // 파일 상태 표시 (OCR, 청크)
        let statusText = '';
        if (file.isImage) {
            if (file.isOcrProcessing) {
                statusText = ' (⏳ OCR 처리 중)';
            } else if (!file.fullText) {
                statusText = ' (🖼️ 이미지 대기)';
            }
        }

        if (!file.isProcessed && file.fullText) {
             statusText = ' (🛠️ 청크 처리 중)';
        }

        if (statusText) {
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

// --- 파일 관리 함수 ---

function deleteFile(index) {
    if (index >= 0 && index < filesData.length) {
        const fileIdToDelete = filesData[index].id;
        
        // 현재 발화 중인 파일이라면 중지
        if (currentFileIndex === index && isSpeaking) {
            stopSpeaking();
        }

        filesData.splice(index, 1);

        // 현재 파일 인덱스 조정
        if (currentFileIndex === index) {
            // 삭제된 파일이 현재 파일이었으면, 다음 파일이나 이전 파일로 이동
            currentFileIndex = -1;
            $textViewer.innerHTML = PLACEHOLDER_HTML; // 뷰어 초기화
        } else if (currentFileIndex > index) {
            currentFileIndex--;
        }

        // 새 파일 선택 또는 목록 업데이트
        if (filesData.length > 0 && currentFileIndex === -1) {
            setCurrentFile(0);
        } else if (filesData.length === 0) {
            // 파일이 모두 삭제된 경우
            currentFileIndex = -1;
        }

        updateFilesList();
        saveBookmark();
    }
}


function setCurrentFile(index) {
    if (index >= 0 && index < filesData.length) {
        currentFileIndex = index;
        currentChunkIndex = 0;
        currentCharIndex = 0;
        stopSpeaking(); // 새 파일 선택 시 중지
        renderChunks();
        updateFilesList();
        saveBookmark();
    }
}

// 파일 목록 클릭 이벤트
$fileList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-file-index]');
    if (li) {
        const index = parseInt(li.dataset.fileIndex);
        if (index !== currentFileIndex) {
            setCurrentFile(index);
        }
    }
});

// 파일 목록 드래그 정렬 (미구현 상태)
// TODO: 여기에 Drag and Drop Reordering 로직을 구현합니다.

// --- 청크 렌더링 및 하이라이트 ---

function renderChunks() {
    if (currentFileIndex === -1 || !filesData[currentFileIndex].isProcessed) {
        $textViewer.innerHTML = PLACEHOLDER_HTML;
        return;
    }

    const chunks = filesData[currentFileIndex].chunks;
    if (chunks.length === 0) {
        $textViewer.innerHTML = `<p>파일 ${filesData[currentFileIndex].name}에 읽을 수 있는 텍스트가 없습니다.</p>`;
        return;
    }

    const fragment = document.createDocumentFragment();
    const startIndex = Math.max(0, currentChunkIndex - Math.floor(VISIBLE_CHUNKS / 2));
    const endIndex = Math.min(chunks.length, startIndex + VISIBLE_CHUNKS);

    // 이전 청크
    for (let i = startIndex; i < currentChunkIndex; i++) {
        const span = document.createElement('span');
        span.classList.add('text-chunk');
        span.dataset.chunkIndex = i;
        span.textContent = chunks[i];
        fragment.appendChild(span);
    }

    // 현재 청크 (하이라이트)
    if (currentChunkIndex >= startIndex && currentChunkIndex < endIndex) {
        const currentChunk = chunks[currentChunkIndex];
        const span = document.createElement('span');
        span.classList.add('text-chunk', 'highlight');
        span.dataset.chunkIndex = currentChunkIndex;
        
        // 현재 문자 하이라이트 (선택 사항)
        const preText = document.createTextNode(currentChunk.substring(0, currentCharIndex));
        const highlightedChar = document.createElement('mark');
        highlightedChar.textContent = currentChunk.substring(currentCharIndex, currentCharIndex + 1);
        const postText = document.createTextNode(currentChunk.substring(currentCharIndex + 1));

        span.appendChild(preText);
        span.appendChild(highlightedChar);
        span.appendChild(postText);
        fragment.appendChild(span);
    }
    
    // 이후 청크
    for (let i = currentChunkIndex + 1; i < endIndex; i++) {
        const span = document.createElement('span');
        span.classList.add('text-chunk');
        span.dataset.chunkIndex = i;
        span.textContent = chunks[i];
        fragment.appendChild(span);
    }

    $textViewer.innerHTML = '';
    $textViewer.appendChild(fragment);

    // 현재 청크로 스크롤
    const highlightedElement = $textViewer.querySelector('.highlight');
    if (highlightedElement) {
        highlightedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// 청크 클릭 이벤트
$textViewer.addEventListener('click', (e) => {
    const chunkElement = e.target.closest('.text-chunk');
    if (chunkElement) {
        const index = parseInt(chunkElement.dataset.chunkIndex);
        if (index !== currentChunkIndex || !isSpeaking) {
            currentChunkIndex = index;
            currentCharIndex = 0;
            if (isSpeaking) {
                stopSpeaking();
            }
            startSpeaking();
        }
    }
});

// --- 발화 제어 ---

function startSpeaking() {
    if (currentFileIndex === -1 || !filesData[currentFileIndex].isProcessed) return;

    const file = filesData[currentFileIndex];
    if (file.chunks.length === 0) return;

    // Wake Lock 요청
    requestWakeLock();

    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️ 일시정지';
    $playPauseBtn.classList.add('speaking');
    
    speakCurrentChunk();
}

function stopSpeaking() {
    if (isSpeaking) {
        synth.cancel();
    }
    isSpeaking = false;
    isPaused = false;
    releaseWakeLock();
    $playPauseBtn.textContent = '▶️ 재생';
    $playPauseBtn.classList.remove('speaking');
    
    // 하이라이트 제거 및 초기화
    currentCharIndex = 0;
    renderChunks();
}

function pauseSpeaking() {
    if (isSpeaking && !isPaused) {
        synth.pause();
        isPaused = true;
        $playPauseBtn.textContent = '▶️ 재개';
        $playPauseBtn.classList.remove('speaking');
        releaseWakeLock();
    }
}

function resumeSpeaking() {
    if (isSpeaking && isPaused) {
        synth.resume();
        isPaused = false;
        $playPauseBtn.textContent = '⏸️ 일시정지';
        $playPauseBtn.classList.add('speaking');
        requestWakeLock();
    }
}

function speakCurrentChunk() {
    if (currentFileIndex === -1 || !filesData[currentFileIndex].isProcessed) return;

    const file = filesData[currentFileIndex];
    if (currentChunkIndex >= file.chunks.length) {
        if (isSequential) {
            // 다음 파일로 이동 (정주행)
            if (currentFileIndex + 1 < filesData.length) {
                setCurrentFile(currentFileIndex + 1);
                startSpeaking();
            } else {
                stopSpeaking();
                console.log("모든 파일 읽기 완료");
            }
        } else {
            stopSpeaking();
        }
        return;
    }

    const text = file.chunks[currentChunkIndex];
    const voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    
    currentUtterance = new SpeechSynthesisUtterance(text);
    currentUtterance.voice = voice;
    currentUtterance.rate = parseFloat($rateSlider.value);
    
    currentUtterance.onend = () => {
        // 청크 완료 시 다음 청크로 이동
        currentChunkIndex++;
        currentCharIndex = 0;
        saveBookmark();
        if (isSpeaking) {
            speakCurrentChunk();
        } else {
            // stopSpeaking으로 발화가 중단되었을 경우
            renderChunks();
        }
    };
    
    currentUtterance.onboundary = (event) => {
        // 단어 경계(word boundary) 이벤트 처리 (선택 사항)
        if (event.name === 'word') {
            currentCharIndex = event.charIndex;
            // 디바운스된 렌더링 호출
            debouncedRenderChunks();
        }
    };

    currentUtterance.onerror = (event) => {
        console.error('SpeechSynthesisUtterance.onerror', event);
        stopSpeaking();
        // 오류 발생 시 다음 청크로 이동 시도 (선택 사항)
        // currentChunkIndex++;
        // speakCurrentChunk();
    };

    // 발화 시작
    synth.speak(currentUtterance);
    renderChunks(); // 하이라이트 갱신
}

const debouncedRenderChunks = debounce(renderChunks, 100);

// --- 제어 버튼 이벤트 리스너 ---

$playPauseBtn.addEventListener('click', () => {
    if (isSpeaking) {
        isPaused ? resumeSpeaking() : pauseSpeaking();
    } else {
        startSpeaking();
    }
});

$stopBtn.addEventListener('click', stopSpeaking);

$prevChunkBtn.addEventListener('click', () => {
    if (currentFileIndex !== -1 && filesData[currentFileIndex].isProcessed) {
        stopSpeaking();
        currentChunkIndex = Math.max(0, currentChunkIndex - 1);
        currentCharIndex = 0;
        renderChunks();
        saveBookmark();
    }
});

$nextChunkBtn.addEventListener('click', () => {
    if (currentFileIndex !== -1 && filesData[currentFileIndex].isProcessed) {
        stopSpeaking();
        currentChunkIndex = Math.min(filesData[currentFileIndex].chunks.length - 1, currentChunkIndex + 1);
        currentCharIndex = 0;
        renderChunks();
        saveBookmark();
    }
});

// 정주행 체크박스 이벤트
if ($sequentialReadCheckbox) {
    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
        saveBookmark();
    });
}

// 모바일 버튼 처리 (실제 파일 첨부/음성 로드 로직은 미구현)
if ($mobileFileUploadBtn) {
    $mobileFileUploadBtn.addEventListener('click', () => {
        alert("모바일 파일 첨부 기능은 구현 중입니다.");
    });
}
if ($mobileLoadVoiceBtn) {
    $mobileLoadVoiceBtn.addEventListener('click', () => {
        alert("모바일 음성 로드 기능은 구현 중입니다.");
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
        selectVoice(bookmark.settings.voice); // 목소리도 로드
    }

    isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    if ($sequentialReadCheckbox) {
        $sequentialReadCheckbox.checked = isSequential;
    }

    // 파일 목록이 로드된 후 북마크된 파일로 이동하는 로직은 파일 로드 방식에 따라 달라집니다.
    // 현재는 파일을 동적으로 추가하므로, 파일 로드 시점에 북마크를 처리해야 합니다.
    // (현재 구현에서는 파일 로드 후 자동적으로 첫 파일이 선택되므로, 이 부분은 생략)
}

// 초기화
window.onload = () => {
    updateRateDisplay();
    // 초기화 시점에 안내 문구가 있다면 확실히 넣어줍니다.
    if ($textViewer.innerHTML.trim() === '') {
        $textViewer.innerHTML = PLACEHOLDER_HTML;
    }
    loadBookmark();
    updateFilesList();
};
