// [중략] - 이전 코드와 동일

// 텍스트 뷰어 초기 안내문
const INITIAL_TEXT_VIEWER_TEXT = '텍스트를 여기에 붙여넣거나(Ctrl+V 또는 Command+V) 파일을 화면에 드래그하여 업로드하세요.';
const INITIAL_TEXT_VIEWER_CONTENT = `<p>${INITIAL_TEXT_VIEWER_TEXT}</p>`;

// [중략] - DOMContentLoaded 및 기타 함수 동일

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

// [중략] - fetchAndProcessUrlContent, processPastedText 함수 동일

/**
 * 텍스트 뷰어 붙여넣기 이벤트 핸들러
 * PC와 모바일 로직을 명확히 분리하여 오류를 방지합니다.
 */
function handlePasteInTextViewer(e) {
    // 1. 초기 안내 문구 제거를 시도합니다.
    clearInitialTextViewerContent();
    
    let pasteData = '';

    if (!isMobile) {
        // **PC/Web 환경:** 클립보드 데이터를 직접 사용하고 기본 붙여넣기 방지 (안정적)
        e.preventDefault(); 
        pasteData = (e.clipboardData || window.clipboardData).getData('text');
        
        const trimmedText = pasteData.trim();
        if (trimmedText) {
            if (URL_PATTERN.test(trimmedText)) {
                fetchAndProcessUrlContent(trimmedText);
            } else {
                processPastedText(trimmedText);
            }
        }
        return;

    } else {
        // **Mobile 환경:**
        // 기본 붙여넣기 동작을 허용해야 클립보드 내용이 DOM에 들어옴. e.preventDefault() 사용 안함.
        
        // **핵심 수정:** 붙여넣기 전에 뷰어를 잠시 비웁니다. 
        // 이렇게 하면 붙여넣기 된 내용만 남게 됩니다. (안내 문구와 섞이는 것 방지)
        // 그러나 clearInitialTextViewerContent()가 이미 실행되어 내용이 비워졌을 가능성이 높습니다.
        // 여기서는 안전하게 기본 동작을 허용한 후, 텍스트를 추출하는 방식을 유지합니다.

        // 붙여넣기 직후 DOM 업데이트를 기다립니다.
        setTimeout(() => {
            // DOM에서 텍스트를 추출하고, 불필요한 HTML과 공백을 정리합니다.
            let extractedText = $textViewer.textContent.trim().replace(/(\n\s*){3,}/g, '\n\n');
            
            // 추출 후 텍스트 뷰어 비우기
            $textViewer.innerHTML = '';

            if (extractedText) {
                // 붙여넣기 된 내용이 초기 안내 문구와 같다면 무시
                const initialText = INITIAL_TEXT_VIEWER_TEXT.trim().replace(/\s+/g, ' ');
                if (extractedText.replace(/\s+/g, ' ') === initialText) {
                     console.log("붙여넣기 내용이 안내 문구와 동일하여 무시됨.");
                     return;
                }
                
                if (URL_PATTERN.test(extractedText)) {
                    fetchAndProcessUrlContent(extractedText);
                } else {
                    processPastedText(extractedText);
                }
            } else {
                console.log("모바일 붙여넣기 후 텍스트 추출 실패 또는 빈 내용");
                // 추출에 실패하면 다시 안내 문구를 표시
                $textViewer.innerHTML = INITIAL_TEXT_VIEWER_CONTENT;
            }
        }, 100); // 지연 시간을 100ms로 약간 늘려 DOM 업데이트 여유를 확보

        return; 
    }
}

// [중략] - 나머지 함수 동일