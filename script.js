// --- 전역 변수 설정 ---
const MAX_FILES = 50; // 파일 첨부 최대 개수 50개
const CHUNK_SIZE_LIMIT = 500; // 한 번에 발화할 텍스트의 최대 글자 수
const VISIBLE_CHUNKS = 10; // 가상화: 한 번에 렌더링할 청크 수
const URL_PATTERN = /^(http|https):\/\/[^\s$.?#].[^\s]*$/i; // URL 인식 패턴

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
const $fileInput = $('#file-input'); // 숨겨진 파일 인풋 (프로그래밍 방식으로 사용)
const $fullScreenDropArea = $('#full-screen-drop-area'); // 새로 추가된 전역 드롭존
const $fileList = $('#file-list');
const $textViewer = $('#text-viewer');
const $voiceSelect = $('#voice-select');
const $rateSlider = $('#rate-slider');
const $rateDisplay = $('#rate-display');
const $playPauseBtn = $('#play-pause-btn');

// 추가된 DOM 요소
const $sequentialReadCheckbox = $('#sequential-read-checkbox');
const $clearAllFilesBtn = $('#clear-all-files-btn');

// 텍스트 뷰어 초기 안내문
const INITIAL_TEXT_VIEWER_TEXT = '텍스트를 여기에 붙여넣거나(Ctrl+V 또는 Command+V) 파일을 화면에 드래그하여 업로드하세요.';
const INITIAL_TEXT_VIEWER_CONTENT = `<p>${INITIAL_TEXT_VIEWER_TEXT}</p>`;

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

    setupFullScreenDragAndDrop(); // 전역 드래그 앤 드롭 설정

    $('#play-pause-btn').addEventListener('click', togglePlayPause);
    $('#stop-btn').addEventListener('click', stopReading);
    $('#next-file-btn').addEventListener('click', () => changeFile(currentFileIndex + 1));
    $('#prev-file-btn').addEventListener('click', () => changeFile(currentFileIndex - 1));

    $rateSlider.addEventListener('input', updateRateDisplay);
    $rateSlider.addEventListener('change', () => saveBookmark());

    loadBookmark();

    setupTextViewerClickEvent();
    $textViewer.addEventListener('paste', handlePasteInTextViewer); // 텍스트 뷰어에 paste 이벤트 추가
    
    // 텍스트 뷰어에 포커스 되었을 때 안내문 자동 제거
    $textViewer.addEventListener('focus', clearInitialTextViewerContent);


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

/**
 * 텍스트 뷰어에 포커스가 갔을 때, 초기 안내 문구라면 내용을 비웁니다.
 */
function clearInitialTextViewerContent() {
    // 텍스트 내용만을 비교
    const currentText = $textViewer.textContent.trim().replace(/\s+/g, ' ');
    const initialText = INITIAL_TEXT_VIEWER_TEXT.trim().replace(/\s+/g, ' ');

    // 현재 내용이 초기 안내문과 같거나 비어있다면 내용을 비웁니다.
    if (currentText === initialText || currentText === '') {
        $textViewer.innerHTML = '';
    }
}


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

// [중략] - 목소리 및 설정, Wake Lock 기능은 변경 없음

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
        $textViewer.innerHTML = '웹페이지 콘텐츠를 불러오는 중입니다...';
        stopReading();
        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error(`HTTP 오류: ${response.status}`);
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');
        
        const novelContentElement = doc.getElementById('novel_content') || doc.getElementById('bo_v_con') || doc.querySelector('article') || doc.querySelector('main');
        let text = '';
        if (novelContentElement) {
            text = novelContentElement.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
        } else {
            // body 텍스트에서 추출 시도 (광범위 추출)
            text = doc.body.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
            // 광고, 메뉴 등 불필요한 텍스트 제거 로직 추가 가능
        }
        
        if (text.length < 50) {
             throw new Error("URL에서 추출된 텍스트 내용이 너무 짧거나 콘텐츠를 찾을 수 없습니다.");
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

        // 로드 성공 후 텍스트 뷰어 비우기
        $textViewer.innerHTML = '';
    } catch (error) {
        alert(`URL 로드 실패: ${error.message}.`);
        $textViewer.innerHTML = `<p style="color:red;">오류 발생: ${error.message}</p>`;
        renderFileList();
    }
}

function processPastedText(text) {
    if (!text) {
        return;
    }

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
    
    // 로드 성공 후 텍스트 뷰어 비우기
    $textViewer.innerHTML = '';
}

/**
 * 텍스트 뷰어 붙여넣기 이벤트 핸들러
 * 모바일 환경에서 텍스트 추출이 안정적으로 이루어지도록 로직을 보강했습니다.
 */
function handlePasteInTextViewer(e) {
    // 1. 초기 안내 문구 제거를 시도합니다.
    clearInitialTextViewerContent();
    
    let pasteData = '';

    if (!isMobile) {
        // PC/Web 환경: 클립보드 데이터 직접 추출이 안정적
        e.preventDefault();
        pasteData = (e.clipboardData || window.clipboardData).getData('text');
    } else {
        // Mobile 환경:
        // 기본 붙여넣기 동작을 허용한 후, DOM에서 텍스트를 추출하는 것이 안정적
        // e.preventDefault()를 사용하지 않습니다.

        // 붙여넣기를 감지하기 위해 임시 Div를 생성하여 붙여넣기를 처리할 수도 있지만,
        // 여기서는 기존 contenteditable 요소를 사용하여 붙여넣기가 완료될 때까지 잠시 기다립니다.
        
        // **중요**: 붙여넣기가 완료될 때까지 지연 시간을 줍니다.
        setTimeout(() => {
            // DOM에서 텍스트를 추출하고, 불필요한 HTML과 공백을 정리합니다.
            let extractedText = $textViewer.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
            
            // 추출 후 텍스트 뷰어 비우기
            $textViewer.innerHTML = '';

            if (extractedText) {
                if (URL_PATTERN.test(extractedText)) {
                    fetchAndProcessUrlContent(extractedText);
                } else {
                    processPastedText(extractedText);
                }
            } else {
                console.log("모바일 붙여넣기 후 텍스트 추출 실패 또는 빈 내용");
            }
        }, 50); // 짧은 지연 시간(50ms)을 주어 DOM 업데이트를 기다립니다.
        
        return; // 모바일에서는 즉시 처리하지 않고 setTimeout으로 위임하고 종료
    }
    
    // PC/Web 처리
    const trimmedText = pasteData.trim();
    if (trimmedText) {
        if (URL_PATTERN.test(trimmedText)) {
            fetchAndProcessUrlContent(trimmedText);
        } else {
            processPastedText(trimmedText);
        }
    }
}

function handleFiles(event) {
    console.log('handleFiles triggered:', event.target.files);
    // 파일 업로드가 시작되면 텍스트 뷰어의 안내 문구를 지웁니다.
    clearInitialTextViewerContent(); 
    
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
    // [중략] - 청크 처리 로직 변경 없음
}

// 전역 드래그 앤 드롭 설정 (텔레그램 스타일)
function setupFullScreenDragAndDrop() {
    // [중략] - 드래그 앤 드롭 로직 변경 없음
}

// --- 재생 컨트롤 기능 ---
async function startReadingFromCurrentChunk() {
    // [중략] - 재생 컨트롤 로직 변경 없음
}

function speakNextChunk() {
    // [중략] - 재생 컨트롤 로직 변경 없음
}

function togglePlayPause() {
    // [중략] - 재생 컨트롤 로직 변경 없음
}

function stopReading() {
    // [중략] - 재생 컨트롤 로직 변경 없음
}

function changeFile(newIndex) {
    // [중략] - 재생 컨트롤 로직 변경 없음
}

// --- 파일 목록 관리 기능 ---
function handleFileListItemClick(e) {
    // [중략] - 파일 목록 관리 로직 변경 없음
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
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT; // 상수 사용
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
    $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT; // 상수 사용
}

function setupFileListSortable() {
    // [중략] - 파일 목록 정렬 로직 변경 없음
}

// --- UI 및 북마크 기능 ---
function renderTextViewer(fileIndex) {
    if (fileIndex === -1 || !filesData[fileIndex]) {
        // 파일이 없을 경우 초기 안내 문구 표시
        $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT; // 상수 사용
        return;
    }

    const file = filesData[fileIndex];
    if (!file.isProcessed) {
        $textViewer.innerHTML = `<p style="color:#FFD700;">[파일 로딩 중/청크 처리 중] : ${file.name}</p>`;
        return;
    }
    // [중략] - 텍스트 뷰어 렌더링 로직 변경 없음
}

function scrollToCurrentChunk() {
    // [중략] - 스크롤 로직 변경 없음
}

function setupTextViewerClickEvent() {
    // [중략] - 텍스트 뷰어 클릭 이벤트 로직 변경 없음
}

function jumpToChunk(index) {
    // [중략] - 청크 이동 로직 변경 없음
}

function renderFileList() {
    // [중략] - 파일 목록 렌더링 로직 변경 없음
}

function saveBookmark() {
    // [중략] - 북마크 저장 로직 변경 없음
}

function loadBookmark() {
    // [중략] - 북마크 로드 로직 변경 없음
}