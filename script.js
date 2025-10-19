// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수

let filesData = []; // 업로드된 모든 파일의 데이터 저장 ({ id, name, fullText, chunks, isProcessed })
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
const $fileInput = $('#file-input');
const $dropArea = $('#drop-area');
const $fileList = $('#file-list');
const $textViewer = $('#text-viewer');
const $voiceSelect = $('#voice-select');
const $rateSlider = $('#rate-slider');
const $rateDisplay = $('#rate-display');
const $playPauseBtn = $('#play-pause-btn');

// 추가된 DOM 요소
const $clipboardTextInput = $('#clipboard-text-input');
const $loadClipboardBtn = $('#load-clipboard-btn');
const $urlTextInput = $('#url-text-input');
const $loadUrlBtn = $('#load-url-btn');
const $sequentialReadCheckbox = $('#sequential-read-checkbox');
const $clearAllFilesBtn = $('#clear-all-files-btn');
// [추가] 모바일 전용 로드 버튼
const $mobileLoadBtn = $('#mobile-load-btn');


// --- 초기화 및 이벤트 리스너 ---
document.addEventListener('DOMContentLoaded', () => {
    if (!('speechSynthesis' in window)) {
        alert('죄송합니다. 이 브라우저는 Web Speech API를 지원하지 않아 서비스를 이용할 수 없습니다.');
        return;
    }

    if (synth.getVoices().length > 0) {
        populateVoiceList();
    }
    synth.onvoiceschanged = populateVoiceList;

    $fileInput.addEventListener('change', handleFiles);
    $('#file-upload-btn').addEventListener('click', () => {
        console.log('File upload button clicked');
        $fileInput.click();
    });

    setupDragAndDrop();

    $('#play-pause-btn').addEventListener('click', togglePlayPause);
    $('#stop-btn').addEventListener('click', stopReading);
    $('#next-file-btn').addEventListener('click', () => changeFile(currentFileIndex + 1));
    $('#prev-file-btn').addEventListener('click', () => changeFile(currentFileIndex - 1));

    $rateSlider.addEventListener('input', updateRateDisplay);
    $rateSlider.addEventListener('change', () => saveBookmark());

    loadBookmark();

    setupTextViewerClickEvent();

    // PC 전용 버튼 이벤트는 유지 (CSS로 모바일에서 숨김 처리됨)
    $loadClipboardBtn.addEventListener('click', handleClipboardText);
    $loadUrlBtn.addEventListener('click', handleUrlText);
    
    // [추가] 모바일 전용 로드 버튼 이벤트
    $mobileLoadBtn.addEventListener('click', handleMobileLoadButtonClick);


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

// --- 파일 처리 및 분할 기능 ---
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
    const PROXY_URL = 'https://api.allorigins.win/raw?url=';
    const targetUrl = PROXY_URL + encodeURIComponent(url);
    try {
        $textViewer.innerHTML = '<p>웹페이지 콘텐츠를 불러오는 중입니다...</p>';
        stopReading();
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error(`HTTP 오류: ${response.status}`);
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        const novelContentElement = doc.getElementById('novel_content') || doc.getElementById('bo_v_con');
        let text = '';
        if (novelContentElement) {
            const pTags = novelContentElement.querySelectorAll('p');
            text = Array.from(pTags).map(p => p.textContent.trim()).join('\n');
            text = text.trim();
        } else {
            throw new Error("페이지에서 ID 'novel_content' 또는 'bo_v_con' 요소를 찾을 수 없습니다.");
        }
        if (text.length < 50) throw new Error("추출된 텍스트 내용이 너무 짧습니다.");

        const fileId = Date.now() + Math.floor(Math.random() * 1000000);
        const fileName = `[URL] ${url.substring(0, 30)}...`;
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

        $urlTextInput.value = '';
    } catch (error) {
        alert(`URL 로드 실패: ${error.message}.`);
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

    const fileId = Date.now() + Math.floor(Math.random() * 1000000);
    const fileName = `[클립보드] ${new Date().toLocaleTimeString()}`;

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

    $clipboardTextInput.value = '';
}

// [추가] 모바일 전용 로드 버튼 핸들러
function handleMobileLoadButtonClick() {
    const url = $urlTextInput.value.trim();
    const text = $clipboardTextInput.value.trim();

    if (url && text) {
        alert("URL 입력 창과 텍스트 입력 창 중 하나만 채워주세요.");
        return;
    }

    if (url) {
        fetchAndProcessUrlContent(url);
    } else if (text) {
        handleClipboardText();
    } else {
        alert("URL 또는 텍스트를 입력/붙여넣기 후 '음성로드' 버튼을 클릭해주세요.");
    }
}


function handleFiles(event) {
    console.log('handleFiles triggered:', event.target.files);
    const newFiles = Array.from(event.target.files).filter(file => file.name.toLowerCase().endsWith('.txt'));
    if (filesData.length + newFiles.length > MAX_FILES) {
        alert(`최대 ${MAX_FILES}개 파일만 첨부할 수 있습니다.`);
        newFiles.splice(MAX_FILES - filesData.length);
    }
    if (newFiles.length === 0) {
        console.log('No valid .txt files selected');
        event.target.value = '';
        return;
    }

    const bookmarkData = localStorage.getItem('autumnReaderBookmark');
    let resumeTargetFileName = JSON.parse(bookmarkData)?.fileName;
    let chunkIndexForResume = JSON.parse(bookmarkData)?.chunkIndex || 0;
    let newFileIndexForResume = -1;

    const filePromises = newFiles.map(file => {
        return (async () => {
            console.log(`Reading file: ${file.name}`);
            let content = '';
            try {
                content = await readTextFile(file, 'UTF-8');
            } catch (error) {
                console.warn(`UTF-8 읽기 중 오류 발생: ${error.message}`);
            }
            if (content.includes('\ufffd') || !content) {
                try {
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
                isProcessed: false
            };
        })();
    });

    Promise.all(filePromises).then(results => {
        const newlyReadFiles = results.filter(file => file !== null);
        if (newlyReadFiles.length === 0) {
            event.target.value = '';
            return;
        }

        newlyReadFiles.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
        const startIndex = filesData.length;
        filesData.push(...newlyReadFiles);

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
        } else if (currentFileIndex === -1) {
            currentFileIndex = startIndex;
            processFileChunks(currentFileIndex, false);
        }

        requestAnimationFrame(renderFileList);
    });

    event.target.value = '';
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
        console.log(`[처리 완료] 파일 "${file.name}" 청크 처리 완료. 총 ${file.chunks.length}개 청크.`);
    }

    if (startReading && currentFileIndex === fileIndex) {
        requestAnimationFrame(() => renderTextViewer(fileIndex));
        startReadingFromCurrentChunk();
    }

    requestAnimationFrame(renderFileList);
}

function setupDragAndDrop() {
    console.log('Setting up drag and drop');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        $dropArea.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        $dropArea.addEventListener(eventName, () => {
            console.log('Drag event:', eventName);
            $dropArea.classList.add('active');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        $dropArea.addEventListener(eventName, () => {
            console.log('Drag event:', eventName);
            $dropArea.classList.remove('active');
        }, false);
    });

    $dropArea.addEventListener('drop', handleDrop, false);

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function handleDrop(e) {
        console.log('File dropped:', e.dataTransfer.files);
        const dt = e.dataTransfer;
        $fileInput.files = dt.files;
        handleFiles({ target: $fileInput });
    }
}

// --- 재생 컨트롤 기능 ---
async function startReadingFromCurrentChunk() {
    if (currentFileIndex === -1) return;

    const file = filesData[currentFileIndex];
    if (!file || !file.isProcessed) {
        alert(`파일 "${file.name}"을(를) 먼저 청크 처리해야 합니다. 처리를 시작합니다.`);
        processFileChunks(currentFileIndex, true);
        return;
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
        alert("재생할 파일을 먼저 선택해주세요.");
        return;
    }

    if (isSpeaking && !isPaused) {
        if (isMobile) {
            synth.cancel(); // 모바일에서 pause 대신 cancel
        } else {
            synth.pause();
        }
        isPaused = true;
        $playPauseBtn.textContent = '▶️';
        releaseWakeLock();
    } else if (isSpeaking && isPaused) {
        if (isMobile) {
            speakNextChunk(); // 모바일에서 resume 대신 재시작 (위치 유지)
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
        processFileChunks(newIndex, true);
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

    if (!filesData[currentFileIndex].isProcessed) {
        processFileChunks(currentFileIndex, true);
    } else {
        startReadingFromCurrentChunk();
    }

    requestAnimationFrame(renderFileList);
    requestAnimationFrame(() => renderTextViewer(currentFileIndex));
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
        $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
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
    $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
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
        $textViewer.innerHTML = '<p>텍스트 파일을 업로드하면 이곳에 내용이 표시됩니다.</p>';
        return;
    }

    const file = filesData[fileIndex];
    if (!file.isProcessed) {
        $textViewer.innerHTML = `<p style="color:#FFD700;">[파일 로딩 중/청크 처리 중] : ${file.name}</p>`;
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
        // [유지] 지연시간 100ms
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