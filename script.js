// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i; // URL 인식 패턴

let filesData = []; // 업로드된 모든 파일의 데이터 저장 ({ id, name, fullText, chunks, isProcessed, isImage, fileObject })
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

// DOM 요소 캐시
const $ = (selector) => document.querySelector(selector);
const $fileInput = $('#file-input'); // 숨겨진 파일 인풋 (프로그래밍 방식으로 사용)
const $fullScreenDropArea = $('#full-screen-drop-area'); // 전역 드롭존
const $fileList = $('#file-list');
const $textViewer = $('#text-viewer');
const $voiceSelect = $('#voice-select');
const $rateSlider = $('#rate-slider');
const $rateDisplay = $('#rate-display');
const $playPauseBtn = $('#play-pause-btn');
const $stopBtn = $('#stop-btn');
const $prevFileBtn = $('#prev-file-btn');
const $nextFileBtn = $('#next-file-btn');
const $sequentialReadCheckbox = $('#sequential-read-checkbox');
const $clearAllFilesBtn = $('#clear-all-files-btn');

// --- 유틸리티 함수 ---

/**
 * 텍스트 파일을 지정된 인코딩으로 읽습니다.
 */
function readTextFile(file, encoding) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result);
        };
        reader.onerror = (error) => {
            reject(error);
        };
        try {
            reader.readAsText(file, encoding);
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * 긴 텍스트를 발화 가능한 크기로 나눕니다.
 */
function chunkText(text) {
    const chunks = [];
    let currentChunk = '';
    const sentences = text.split(/([.?!。？！]\s*)/g).filter(s => s.trim().length > 0);

    for (let i = 0; i < sentences.length; i++) {
        const sentence = sentences[i];

        if ((currentChunk + sentence).length > CHUNK_SIZE_LIMIT) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
        }
        currentChunk += sentence;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks.filter(c => c.length > 0);
}

// --- OCR 처리 함수 추가 ---

/**
 * Tesseract.js를 사용하여 이미지 파일을 OCR로 처리합니다.
 */
async function processImageFileWithOCR(fileData) {
    const file = fileData.fileObject;
    const fileId = fileData.id;

    try {
        // Tesseract Worker 생성. 한국어(kor)를 사용합니다.
        const worker = await Tesseract.createWorker('kor', {
            // 진행 상황 로깅을 통해 상태를 확인할 수 있습니다.
            logger: m => {
                if (m.status === 'recognizing text') {
                    const progress = (m.progress * 100).toFixed(0);
                    const index = filesData.findIndex(f => f.id === fileId);
                    if (index !== -1) {
                        filesData[index].fullText = `[🤖 OCR 중...] ${file.name} (${progress}%)`;
                        renderFileList();
                    }
                }
            }
        });

        // OCR 인식 시작
        const { data: { text } } = await worker.recognize(file);
        
        // 작업 완료 후 Worker 종료
        await worker.terminate();

        // 성공적으로 텍스트를 추출한 경우
        const extractedText = text.trim().replace(/(\n\s*){3,}/g, '\n\n');
        
        if (extractedText.length === 0) {
            throw new Error("OCR 인식 결과 텍스트가 추출되지 않았거나 인식률이 매우 낮습니다.");
        }

        // filesData에서 이 파일을 찾아 업데이트
        const index = filesData.findIndex(f => f.id === fileId);
        if (index !== -1) {
            filesData[index].fullText = extractedText;
            filesData[index].isProcessed = true;
            filesData[index].isImage = false; // 처리 완료
            // 청크 처리 및 재생 시작 (currentFileIndex와 일치하면 자동 재생)
            processFileChunks(index, true); 
        }

    } catch (error) {
        console.error(`OCR 처리 중 오류 발생 (${file.name}):`, error);
        
        // 실패 시 목록에서 상태 업데이트
        const index = filesData.findIndex(f => f.id === fileId);
        if (index !== -1) {
            const errorMessage = `[OCR 실패] ${file.name}: ${error.message || '알 수 없는 오류'}`;
            filesData[index].name = `❌ ${filesData[index].name}`;
            filesData[index].fullText = errorMessage;
            filesData[index].isProcessed = true; // 처리 실패로 마크
            filesData[index].isImage = false; 
            processFileChunks(index, false); // 실패 텍스트로 청크 생성 및 목록 업데이트
            alert(errorMessage);
        }
    }
}


// --- 핵심 파일 처리 로직 ---

/**
 * 파일 데이터를 청크로 나누고 뷰어를 업데이트합니다.
 */
function processFileChunks(fileIndex, shouldResume) {
    if (fileIndex < 0 || fileIndex >= filesData.length) return;

    const file = filesData[fileIndex];
    if (file.isImage && !file.isProcessed) {
        // OCR 처리 중인 파일이면 청크 처리를 건너뜁니다.
        renderFileList();
        return; 
    }

    if (file.chunks.length === 0) {
        file.chunks = chunkText(file.fullText);
    }
    
    // 파일 목록 업데이트 (active 상태 표시 등)
    renderFileList();

    // 청크가 없는 경우 (빈 파일 또는 OCR 실패로 텍스트 없음)
    if (file.chunks.length === 0) {
        $textViewer.innerHTML = `<p class="chunk-item">파일 내용이 비어있습니다.</p>`;
        return;
    }

    // 현재 파일 인덱스가 선택된 경우에만 뷰어를 업데이트하고 재생을 시작합니다.
    if (fileIndex === currentFileIndex) {
        renderTextViewer();

        if (shouldResume) {
            // 현재 청크 위치로 스크롤
            const activeChunkElement = document.getElementById(`chunk-${currentChunkIndex}`);
            if (activeChunkElement) {
                activeChunkElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            // 이어서 읽기
            startReading();
        }
    }
}


/**
 * 파일 입력 또는 드롭 이벤트 발생 시 파일을 처리합니다.
 */
function handleFiles(event) {
    console.log('handleFiles triggered:', event.target.files);
    clearInitialTextViewerContent();
    stopReading(); // 파일 처리 시작 전 현재 발화 중지

    const allFiles = Array.from(event.target.files);
    if (filesData.length + allFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부할 수 있습니다.`);
        allFiles.splice(MAX_FILES - filesData.length);
    }
    if (allFiles.length === 0) {
        console.log('No valid files selected');
        event.target.value = '';
        return;
    }

    const txtFiles = allFiles.filter(file => file.name.toLowerCase().endsWith('.txt'));
    const imageFiles = allFiles.filter(file => 
        file.name.toLowerCase().endsWith('.jpg') || 
        file.name.toLowerCase().endsWith('.jpeg') || 
        file.name.toLowerCase().endsWith('.png')
    );

    // 1. 텍스트 파일 처리 (순차적으로 읽고 대기열에 추가)
    const txtFilePromises = txtFiles.map(file => {
        return (async () => {
            console.log(`Reading text file: ${file.name}`);
            let content = '';
            try {
                // 1차 시도: UTF-8
                content = await readTextFile(file, 'UTF-8');
            } catch (error) {
                console.warn(`UTF-8 읽기 중 오류 발생: ${error.message}`);
            }
            if (content.includes('\ufffd') || !content) {
                try {
                    // 2차 시도: ANSI/windows-949 (한국어 환경에서 흔한 인코딩)
                    content = await readTextFile(file, 'windows-949');
                    if (!content) throw new Error("인코딩 재시도 후에도 내용이 비어있습니다.");
                    console.log(`파일 "${file.name}"을(를) ANSI/windows-949 인코딩으로 읽었습니다.`);
                } catch (error) {
                    alert(`파일 "${file.name}"을(를) 읽는 데 실패했습니다. 파일 인코딩을 확인해 주세요.`);
                    return null;
                }
            }

            const fileId = Date.now() + Math.floor(Math.random() * 1000000);
            return {
                id: fileId,
                name: file.name,
                fullText: content,
                chunks: [],
                isProcessed: true, // 텍스트 파일은 바로 처리 완료
                isImage: false
            };
        })();
    });

    Promise.all(txtFilePromises).then(results => {
        const newlyReadFiles = results.filter(file => file !== null);
        if (newlyReadFiles.length === 0 && imageFiles.length === 0) {
            event.target.value = '';
            return;
        }

        // 파일 정렬 (파일명 기준)
        newlyReadFiles.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
        const startIndex = filesData.length;
        filesData.push(...newlyReadFiles);

        // 북마크 복원 로직
        const bookmarkData = localStorage.getItem('autumnReaderBookmark');
        let resumeTargetFileName = JSON.parse(bookmarkData)?.fileName;
        let chunkIndexForResume = JSON.parse(bookmarkData)?.chunkIndex || 0;
        let newFileIndexForResume = -1;
        let shouldResume = false;

        if (resumeTargetFileName) {
            const resumeFileIndexInNewList = newlyReadFiles.findIndex(f => f.name === resumeTargetFileName);
            if (resumeFileIndexInNewList !== -1) {
                newFileIndexForResume = startIndex + resumeFileIndexInNewList;
                shouldResume = true;
            }
        }

        if (shouldResume) {
            const resume = confirm(`[북마크 복원] "${filesData[newFileIndexForResume].name}"의 저장된 위치(${chunkIndexForResume + 1}번째 청크)부터 이어서 읽으시겠습니까?`);
            if (resume) {
                currentFileIndex = newFileIndexForResume;
                currentChunkIndex = chunkIndexForResume;
                processFileChunks(currentFileIndex, true);
            }
        } else if (currentFileIndex === -1 && filesData.length > 0) {
            // 첫 파일 로드 시 자동 선택
            currentFileIndex = startIndex;
            processFileChunks(currentFileIndex, false);
        } else if (filesData.length > 0) {
             // 기존 파일이 있는 상태에서 추가 로드 시, 새로 추가된 파일에 대해서만 청크 처리
            for(let i = startIndex; i < filesData.length; i++) {
                processFileChunks(i, false);
            }
        }

        requestAnimationFrame(renderFileList);

        // 2. 이미지 파일 처리 (비동기 OCR 처리)
        imageFiles.forEach(file => {
            // 파일을 배열의 맨 앞에 추가하고 OCR 처리를 시작
            const fileId = Date.now() + Math.floor(Math.random() * 1000000);
            const newImageFileData = {
                id: fileId,
                name: file.name,
                fullText: `[🤖 OCR 중] ${file.name}`,
                chunks: [],
                isProcessed: false, // 처리 완료 전까지 false
                isImage: true,
                fileObject: file // 원본 파일 객체 저장
            };
            filesData.unshift(newImageFileData);
            
            // Tesseract.js를 사용하여 OCR 비동기 처리 시작
            processImageFileWithOCR(newImageFileData); 
        });
        
        // 이미지 파일을 추가했으므로 파일 목록 한 번 더 렌더링
        requestAnimationFrame(renderFileList);
    });

    event.target.value = ''; // 파일 입력 필드 초기화
}

// --- 발화 로직 ---

function startReading() {
    if (currentFileIndex === -1 || filesData[currentFileIndex].chunks.length === 0) {
        isSpeaking = false;
        $playPauseBtn.textContent = '▶️';
        return;
    }
    
    if (synth.speaking) {
        if (isPaused) {
            synth.resume();
            isPaused = false;
            $playPauseBtn.textContent = '⏸️';
            isSpeaking = true;
            toggleWakeLock(true);
            return;
        }
        // 이미 발화 중이면 무시
        return; 
    }

    if (currentChunkIndex >= filesData[currentFileIndex].chunks.length) {
        // 현재 파일의 끝에 도달
        if (isSequential) {
            moveToNextFile();
            return;
        } else {
            // 정주행이 아니면 멈춥니다.
            stopReading();
            return;
        }
    }

    isSpeaking = true;
    isPaused = false;
    $playPauseBtn.textContent = '⏸️';
    toggleWakeLock(true);
    speakCurrentChunk();
}

function speakCurrentChunk() {
    if (currentFileIndex === -1) return;

    const file = filesData[currentFileIndex];
    if (currentChunkIndex >= file.chunks.length) {
        if (isSequential) {
            moveToNextFile();
        } else {
            stopReading();
        }
        return;
    }
    
    // 뷰어 업데이트 및 스크롤
    renderTextViewer();
    
    // 발화 객체 생성
    const textToSpeak = file.chunks[currentChunkIndex];
    currentUtterance = new SpeechSynthesisUtterance(textToSpeak);
    currentUtterance.voice = synth.getVoices().find(v => v.name === $voiceSelect.value);
    currentUtterance.rate = parseFloat($rateSlider.value);
    
    // 발화 종료 이벤트
    currentUtterance.onend = () => {
        if (isSpeaking && !isPaused) {
            currentChunkIndex++;
            speakCurrentChunk(); // 다음 청크 발화
        }
    };

    currentUtterance.onerror = (event) => {
        console.error('SpeechSynthesisUtterance.onerror', event);
        // 에러 발생 시 다음 청크로 넘어가기 시도
        if (isSpeaking && !isPaused) {
            currentChunkIndex++;
            speakCurrentChunk();
        }
    };

    synth.speak(currentUtterance);
}

function togglePlayPause() {
    if (isSpeaking) {
        if (isPaused) {
            startReading(); // 재생
        } else {
            synth.pause();
            isPaused = true;
            $playPauseBtn.textContent = '▶️';
            toggleWakeLock(false);
        }
    } else {
        // 정지 상태에서 재생 시작
        if (currentFileIndex === -1 && filesData.length > 0) {
            currentFileIndex = 0;
            currentChunkIndex = 0;
            processFileChunks(currentFileIndex, true); // 첫 파일 청크 처리 및 재생 시작
        } else {
            startReading();
        }
    }
}

function stopReading() {
    if (synth.speaking) {
        synth.cancel();
    }
    isSpeaking = false;
    isPaused = false;
    $playPauseBtn.textContent = '▶️';
    // 하이라이트 제거는 renderTextViewer에서 처리
    renderTextViewer();
    toggleWakeLock(false);
}

function moveToNextChunk() {
    if (currentFileIndex === -1) return;
    
    stopReading(); // 현재 발화 중지
    currentChunkIndex++;
    if (currentChunkIndex >= filesData[currentFileIndex].chunks.length) {
        currentChunkIndex = filesData[currentFileIndex].chunks.length - 1; // 마지막 청크 유지
        if (isSequential) {
            moveToNextFile(); // 다음 파일로 이동
            return;
        }
    }
    startReading(); // 다음 청크부터 재생
}

function moveToPrevChunk() {
    if (currentFileIndex === -1) return;
    
    stopReading(); // 현재 발화 중지
    currentChunkIndex--;
    if (currentChunkIndex < 0) {
        currentChunkIndex = 0;
        if (isSequential) {
            moveToPrevFile(); // 이전 파일로 이동
            return;
        }
    }
    startReading(); // 이전 청크부터 재생
}

function moveToNextFile() {
    stopReading();
    currentFileIndex++;
    if (currentFileIndex >= filesData.length) {
        currentFileIndex = filesData.length - 1; // 마지막 파일 유지
        stopReading(); // 끝에 도달하면 정지
        return;
    }
    currentChunkIndex = 0;
    processFileChunks(currentFileIndex, true);
}

function moveToPrevFile() {
    stopReading();
    currentFileIndex--;
    if (currentFileIndex < 0) {
        currentFileIndex = 0; // 첫 파일 유지
        stopReading(); // 처음이면 정지
        return;
    }
    currentChunkIndex = 0;
    processFileChunks(currentFileIndex, true);
}

// --- UI 및 상태 관리 ---

/**
 * 텍스트 뷰어 내용을 현재 파일의 청크로 렌더링하고 활성 청크를 하이라이트합니다.
 */
function renderTextViewer() {
    if (currentFileIndex === -1) {
        $textViewer.innerHTML = '<p>파일을 업로드하거나 텍스트를 붙여넣으세요.</p>';
        return;
    }

    const file = filesData[currentFileIndex];
    if (file.chunks.length === 0) {
        // 청크가 없으면 전체 텍스트를 표시
        $textViewer.innerHTML = `<p>${file.fullText.replace(/\n/g, '</p><p>')}</p>`;
        return;
    }

    let html = '';
    const startIndex = Math.max(0, currentChunkIndex - Math.floor(VISIBLE_CHUNKS / 2));
    const endIndex = Math.min(file.chunks.length, startIndex + VISIBLE_CHUNKS);

    // 가상화: 보여줄 청크만 렌더링
    for (let i = startIndex; i < endIndex; i++) {
        const isActive = i === currentChunkIndex;
        html += `<p id="chunk-${i}" class="chunk-item ${isActive ? 'active-chunk' : ''}" data-index="${i}">`;
        html += file.chunks[i].replace(/\n/g, '<br>'); // 줄바꿈 처리
        html += `</p>`;
    }

    $textViewer.innerHTML = html;

    // 활성 청크로 스크롤
    const activeChunkElement = document.getElementById(`chunk-${currentChunkIndex}`);
    if (activeChunkElement) {
        activeChunkElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

/**
 * 음성 목록을 로드하고 드롭다운을 초기화합니다.
 */
function initVoiceSelect() {
    if (!synth.onvoiceschanged) {
        synth.onvoiceschanged = () => {
            populateVoiceList();
        };
    } else {
        populateVoiceList();
    }
}

function populateVoiceList() {
    $voiceSelect.innerHTML = '';
    const voices = synth.getVoices();
    const koreanVoices = voices.filter(voice => voice.lang.startsWith('ko-'));

    let selectedVoiceName = localStorage.getItem('selectedVoiceName') || 'Google 한국의'; // 기본값

    // 한국어 음성이 없으면 다른 음성도 표시
    const voicesToUse = koreanVoices.length > 0 ? koreanVoices : voices;

    voicesToUse.forEach(voice => {
        const option = document.createElement('option');
        option.textContent = `${voice.name} (${voice.lang})`;
        if (voice.default) {
            option.textContent += ' (기본)';
        }
        option.value = voice.name;
        
        // 이전에 선택된 음성 또는 기본 음성 선택
        if (voice.name === selectedVoiceName || (koreanVoices.length > 0 && voice.name === 'Google 한국의') || (voice.default && !selectedVoiceName)) {
             option.selected = true;
             selectedVoiceName = voice.name; // 실제 선택된 음성 이름 업데이트
        }
        
        $voiceSelect.appendChild(option);
    });
    
    // 로컬 스토리지에 실제 선택된 음성 저장
    localStorage.setItem('selectedVoiceName', selectedVoiceName);
}

function updateRateDisplay() {
    $rateDisplay.textContent = $rateSlider.value;
}

function deleteFile(fileId) {
    stopReading();
    const index = filesData.findIndex(file => file.id === fileId);
    if (index > -1) {
        filesData.splice(index, 1);
        
        if (index === currentFileIndex) {
            // 삭제된 파일이 현재 파일이면 인덱스 초기화
            currentFileIndex = -1;
            currentChunkIndex = 0;
            $textViewer.innerHTML = '<p>파일이 삭제되었습니다. 새로운 파일을 선택하세요.</p>';
            localStorage.removeItem('autumnReaderBookmark');
        } else if (index < currentFileIndex) {
            // 삭제된 파일이 현재 파일보다 앞에 있으면 인덱스 조정
            currentFileIndex--;
        }
    }
    renderFileList();
}

function clearAllFiles() {
    if (confirm('모든 파일을 목록에서 삭제하시겠습니까?')) {
        stopReading();
        filesData = [];
        currentFileIndex = -1;
        currentChunkIndex = 0;
        $fileList.innerHTML = '';
        $textViewer.innerHTML = '<p>텍스트를 여기에 붙여넣거나(Ctrl+V 또는 Command+V) 파일을 화면에 드래그하여 업로드하세요.</p>';
        localStorage.removeItem('autumnReaderBookmark');
        renderFileList(); // 목록 업데이트
    }
}

/**
 * 파일 목록 UI를 렌더링하고 이벤트 리스너를 추가합니다.
 */
function renderFileList() {
    $fileList.innerHTML = '';

    filesData.forEach((file, index) => {
        const li = document.createElement('li');
        li.dataset.id = file.id;
        li.draggable = true;
        li.title = `클릭하여 ${file.name} 재생/선택`;

        const fileNameSpan = document.createElement('span');
        fileNameSpan.className = 'file-name';
        fileNameSpan.textContent = file.name;

        // --- 상태 표시 ---
        if (!file.isProcessed) {
            const statusSpan = document.createElement('span');
            if (file.isImage) {
                // OCR 처리 중
                statusSpan.textContent = ' (🤖 OCR 중...)';
                statusSpan.style.color = '#1E90FF';
            } else {
                // 대기 중 (일반 텍스트 파일)
                statusSpan.textContent = ' (⏳ 대기)';
                statusSpan.style.color = '#FFD700';
            }
            fileNameSpan.appendChild(statusSpan);
        } else if (file.fullText.startsWith('[OCR 실패]')) {
             const statusSpan = document.createElement('span');
             statusSpan.textContent = ' (❌ 실패)';
             statusSpan.style.color = '#FF4444';
             fileNameSpan.appendChild(statusSpan);
        }
        // --- 상태 표시 끝 ---

        // 컨트롤 영역
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'file-controls';

        // 드래그 핸들
        const dragHandle = document.createElement('span');
        dragHandle.className = 'drag-handle';
        dragHandle.textContent = '☰';
        dragHandle.title = '순서 변경';

        // 삭제 버튼
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-file-btn';
        deleteBtn.textContent = 'X';
        deleteBtn.title = '파일 삭제';
        deleteBtn.onclick = (e) => {
            e.stopPropagation(); // li 클릭 이벤트 방지
            deleteFile(file.id);
        };
        
        // 파일 클릭 (선택/재생)
        li.onclick = () => {
             // OCR 처리 중인 파일은 선택할 수 없습니다.
            if (file.isImage && !file.isProcessed) {
                alert('OCR 처리 중인 파일입니다. 잠시 후 다시 시도해 주세요.');
                return;
            }
            stopReading();
            currentFileIndex = index;
            currentChunkIndex = 0;
            processFileChunks(currentFileIndex, true); // 자동 재생
        };

        controlsDiv.appendChild(dragHandle);
        controlsDiv.appendChild(deleteBtn);

        li.appendChild(fileNameSpan);
        li.appendChild(controlsDiv);

        li.classList.toggle('active', index === currentFileIndex);

        $fileList.appendChild(li);
    });

    // Sortable.js 업데이트
    setupDragAndDrop();
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
        // 음성 로딩은 비동기이므로, 나중에 선택
        // $voiceSelect.value = bookmark.settings.voice; 
        $rateSlider.value = bookmark.settings.rate;
        updateRateDisplay();
    }
    
    // voiceSelect가 로드된 후 북마크 음성 적용
    const applyVoiceOnLoad = setInterval(() => {
        if (synth.getVoices().length > 0) {
            if ($voiceSelect.querySelector(`option[value="${bookmark.settings.voice}"]`)) {
                 $voiceSelect.value = bookmark.settings.voice;
            } else {
                 console.warn("북마크된 음성을 찾을 수 없어 기본 음성으로 설정됩니다.");
            }
            clearInterval(applyVoiceOnLoad);
        }
    }, 100);

    isSequential = bookmark.isSequential !== undefined ? bookmark.isSequential : true;
    if ($sequentialReadCheckbox) {
        $sequentialReadCheckbox.checked = isSequential;
    }

    // 파일이 로드된 후 북마크 파일 찾기 및 재개는 handleFiles에서 처리
}

// --- 드래그 앤 드롭 및 텍스트 뷰어 입력 처리 ---

function setupDragAndDrop() {
    new Sortable($fileList, {
        handle: '.drag-handle',
        animation: 150,
        onEnd: function (evt) {
            // 파일 순서 변경
            const [movedItem] = filesData.splice(evt.oldIndex, 1);
            filesData.splice(evt.newIndex, 0, movedItem);

            // 현재 재생 중인 파일 인덱스 조정
            if (currentFileIndex === evt.oldIndex) {
                currentFileIndex = evt.newIndex;
            } else if (currentFileIndex > evt.oldIndex && currentFileIndex <= evt.newIndex) {
                currentFileIndex--;
            } else if (currentFileIndex < evt.oldIndex && currentFileIndex >= evt.newIndex) {
                currentFileIndex++;
            }

            renderFileList();
        },
    });
}

function handleDrop(event) {
    event.preventDefault();
    $fullScreenDropArea.style.display = 'none';

    const files = event.dataTransfer.files;
    // 파일을 <input type="file">에 할당하여 handleFiles를 호출합니다.
    $fileInput.files = files;
    handleFiles({ target: $fileInput });
}

function clearInitialTextViewerContent() {
    if ($textViewer.innerHTML.includes('<p>텍스트를 여기에 붙여넣거나')) {
        $textViewer.innerHTML = '';
    }
}

function handleTextViewerChange() {
    const content = $textViewer.textContent.trim();
    if (content.length > 0) {
        // 텍스트를 파일 목록에 추가하는 로직
        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const fileName = content.substring(0, 15) + (content.length > 15 ? '...' : '');

        const newFile = {
            id: fileId,
            name: `(입력) ${fileName}`,
            fullText: content,
            chunks: [],
            isProcessed: true,
            isImage: false
        };
        
        // 뷰어 내용을 파일로 변환 후 뷰어 초기화
        $textViewer.innerHTML = '';
        
        filesData.unshift(newFile);
        
        // 현재 재생 중이 아니면 새로 추가된 파일 선택
        if (currentFileIndex === -1) {
            currentFileIndex = 0;
        } else {
            currentFileIndex++; // 기존 파일들이 뒤로 밀림
        }
        currentChunkIndex = 0;
        
        processFileChunks(currentFileIndex, true); // 청크 처리 및 재생 시작
    }
}


function handlePaste(event) {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    // 붙여넣기 후 파일 처리 로직을 위해 잠시 후에 handleTextViewerChange 호출
    setTimeout(handleTextViewerChange, 50);
}


// --- Wake Lock 및 NoSleep.js 관리 ---

/**
 * 화면 꺼짐 방지 기능을 켜거나 끕니다.
 */
async function toggleWakeLock(shouldBeActive) {
    if (isMobile) {
        // 모바일 환경에서는 NoSleep.js 사용
        if (!noSleep) {
            noSleep = new NoSleep();
        }
        if (shouldBeActive) {
            noSleep.enable();
            // console.log('NoSleep activated');
        } else {
            noSleep.disable();
            // console.log('NoSleep deactivated');
        }
        return;
    }

    // 데스크톱 환경에서는 Wake Lock API 사용
    if ('wakeLock' in navigator) {
        if (shouldBeActive) {
            if (!wakeLock) {
                try {
                    wakeLock = await navigator.wakeLock.request('screen');
                    // console.log('Screen Wake Lock activated');
                    wakeLock.addEventListener('release', () => {
                        wakeLock = null;
                        // console.log('Screen Wake Lock released');
                    });
                } catch (err) {
                    // console.error(`${err.name}, ${err.message}`);
                    wakeLock = null;
                }
            }
        } else if (wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    }
}


// --- 이벤트 리스너 초기화 ---

function initEventListeners() {
    // 파일 입력 버튼 클릭
    $('#file-input-label')?.addEventListener('click', () => {
        $fileInput.click();
    });

    // 숨겨진 파일 인풋 변경
    $fileInput.addEventListener('change', handleFiles);

    // 전체 화면 드롭 영역 처리
    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
        $fullScreenDropArea.style.display = 'flex';
    });

    $fullScreenDropArea.addEventListener('dragleave', () => {
        $fullScreenDropArea.style.display = 'none';
    });
    
    $fullScreenDropArea.addEventListener('drop', handleDrop);
    
    // 컨트롤 버튼
    $voiceSelect.addEventListener('change', (e) => {
         localStorage.setItem('selectedVoiceName', e.target.value);
    });
    $rateSlider.addEventListener('input', updateRateDisplay);
    $playPauseBtn.addEventListener('click', togglePlayPause);
    $stopBtn.addEventListener('click', stopReading);
    $prevFileBtn.addEventListener('click', moveToPrevChunk);
    $nextFileBtn.addEventListener('click', moveToNextChunk);
    $sequentialReadCheckbox.addEventListener('change', (e) => {
        isSequential = e.target.checked;
    });
    $clearAllFilesBtn.addEventListener('click', clearAllFiles);

    // 텍스트 뷰어 입력 처리
    // 엔터 키 입력 방지 및 텍스트 자동 인식
    $textViewer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
        }
    });
    $textViewer.addEventListener('input', handleTextViewerChange);
    $textViewer.addEventListener('paste', handlePaste);
    
    // 창 닫기/새로고침 시 북마크 저장
    window.addEventListener('beforeunload', saveBookmark);
    
    // 초기화
    initVoiceSelect();
    updateRateDisplay();
    loadBookmark(); // 북마크 로드 (파일 로드는 handleFiles에서 처리됨)
    renderTextViewer(); // 초기 뷰어 렌더링
    renderFileList(); // 초기 목록 렌더링
}

// 애플리케이션 시작
document.addEventListener('DOMContentLoaded', initEventListeners);