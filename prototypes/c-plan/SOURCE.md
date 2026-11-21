# TRAIGO C안 예비 UI 원본

배포 URL https://traigo-c-prototype.steadyowl136.chatgpt.site

Sites 소스 커밋 `d87db3543681e008e3889e078e805e77f367d8e8`

세 파일은 해당 커밋의 `dist/`에서 그대로 복사했다.

원본과 바이트 단위로 비교하려면 GitHub 저장소 루트에서 실행한다.

```sh
for file in index.html style.css app.js; do
  git -C "$SITES_CHECKOUT" show "d87db3543681e008e3889e078e805e77f367d8e8:dist/$file" |
    cmp - "prototypes/c-plan/$file" || exit 1
done
```

`SITES_CHECKOUT`에는 Sites 원본 저장소 체크아웃 경로를 지정한다. 아래 세 줄을 `sha256sum -c`에 전달해 복사본의 해시를 검사할 수 있다.

```text
ea45d1b381bbb2072d5af130ab7a3a8553355797d8f0b38458cfd6bc2d6ed5fe  prototypes/c-plan/index.html
9e96c1f45d0bf1b037bab9365e84a0702fb54b84924c6999b61e5e17b28517a7  prototypes/c-plan/style.css
dc8647791490b69c4b900833bb78326952d778c4bf5b78cbe82125771c3f66f3  prototypes/c-plan/app.js
```
