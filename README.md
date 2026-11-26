# NIJI VOICE

Google Drive(공유 드라이브 `NIJISANJI` — `NIJI VOICE` 폴더)에 모아 둔 보이스 아카이브를 위한
**모바일 우선 PWA 플레이어**입니다. 아이폰 홈 화면에 설치하면 앱처럼 열립니다.

- 배포 주소: <https://harumana.github.io/niji-voice/>
- 저장소: <https://github.com/harumana/niji-voice>

음원·자막·메모는 **이 저장소에 없습니다.** 브라우저에서 본인 Google 계정으로 로그인해
Google Drive API로 직접 읽고, 공유 메타데이터만 드라이브의 `_niji_voice_meta.json`에 저장합니다.

## 기능

**재생 · 탐색**
- 전체 파일 / 즐겨찾기 / 재생목록 / 폴더로 보기 / 메모 모아보기 / 가사 검색
- 파일 이름 검색, 연도·라이버·태그 필터(복수 선택), 최신순·이름순 정렬
- 선택 모드로 여러 파일에 태그를 한 번에 붙이기
- 잠금화면·제어센터 연동(MediaSession): 곡명·아티스트·커버·이전/다음/재생

**자막 · 메모**
- MP3의 ID3v2 태그를 브라우저에서 직접 파싱 → `APIC` 커버, `USLT` 일한 병기 타임싱크 가사
- 가사 라인을 누르면 그 지점으로 이동, 재생에 맞춰 자동 스크롤
- 타임스탬프 메모: 드라이브 공유 JSON에 저장(작성자·시각·초), 눌러서 점프
- 다른 사람이 남긴 새 메모는 `NEW` 배지로 표시 (마지막 확인 시각과 비교)
- 가사 키워드 검색: 인덱싱된 자막(일본어/한국어)에서 찾아 해당 파일·지점으로 바로 재생

**듣기 편의**
- A–B 구간 반복 (A → B → 해제)
- 취침 타이머: 15분 / 30분 / 60분 / 현재 트랙 종료 후
- 오프라인 저장: 개별 트랙을 IndexedDB에 저장하면 네트워크 없이 재생

**데이터**
- 기기에만 저장: 즐겨찾기, 재생목록, 닉네임, 마지막 확인 시각 (`localStorage`)
- 드라이브에 공유 저장: 태그, 메모, 자막, 재생 길이 캐시 (`_niji_voice_meta.json`)
- 오프라인 저장·가사 인덱스·커버 캐시: 브라우저 `IndexedDB`

## 연결 방법 (최초 1회)

1. **Google Cloud Console** → 새 프로젝트 → *API 및 서비스* → **Google Drive API** 사용 설정
2. *OAuth 동의 화면* → 외부 → 앱 이름 아무거나, 테스트 사용자에 본인 Gmail 추가
3. *사용자 인증 정보* → **OAuth 클라이언트 ID 만들기** → 애플리케이션 유형 **웹 애플리케이션**
   - 승인된 JavaScript 출처: `https://harumana.github.io`
   - (로컬 테스트 시 `http://localhost:8000` 도 추가)
4. 발급된 **클라이언트 ID**(`....apps.googleusercontent.com`)를 앱의 **설정**에 붙여넣고 저장
5. **연결하기** → Google 로그인 → 드라이브에서 `NIJI VOICE` 폴더를 자동으로 찾습니다.
   못 찾으면 설정에서 폴더 ID나 드라이브 링크를 직접 넣어 주세요.

> OAuth Client ID는 비밀 값이 아니며(공개되어도 무방), 이 앱은 ID를 브라우저 `localStorage`에만
> 저장합니다. Client Secret은 이 앱에서 쓰지 않습니다.

## 아이폰 홈 화면 설치

Safari로 <https://harumana.github.io/niji-voice/> 를 연 뒤 **공유 → 홈 화면에 추가**.
홈 화면에서 열면 주소창 없이 전체 화면으로 뜹니다.

## 로컬에서 실행

정적 파일만으로 동작합니다. ES 모듈이라 `file://` 로는 열리지 않으니 간단한 서버를 씁니다.

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## 구조

```
index.html            화면 골격
css/app.css           스타일 (라이트/다크)
js/app.js             상태·화면·이벤트
js/drive.js           GIS OAuth, Drive API, 공유 메타데이터
js/id3.js             ID3v2 파서 (APIC/USLT/TIT2…), LRC 파서
js/player.js          오디오 엔진, MediaSession, A–B, 취침 타이머
js/db.js              IndexedDB (오프라인 오디오·파싱 캐시)
js/demo.js            데모 모드(합성 오디오·샘플 커버)
sw.js, manifest.webmanifest, icons/
```

## 개인정보

- 서버가 없습니다. 모든 요청은 사용자의 브라우저 → Google API로 직접 갑니다.
- 이 저장소에는 API 키, OAuth 시크릿, 이메일, 음원, 자막, 메모가 들어 있지 않습니다.
- 드라이브 접근 범위는 `https://www.googleapis.com/auth/drive` (목록 조회·스트리밍·공유 메모 쓰기).
  연결을 해제하면 토큰을 즉시 폐기(`revoke`)합니다.

## 알려진 제약

- iOS 웹앱은 화면을 끈 채 아주 오래 재생하면 다음 곡 자동 넘어감이 끊길 수 있습니다.
- 첫 재생은 해당 트랙을 내려받기 때문에 파일 크기에 따라 잠깐 기다립니다(캐시 후 즉시 재생).
- 드라이브 파일은 `alt=media`로 받아 `blob:` URL로 재생합니다(권한 헤더가 필요한 파일).
