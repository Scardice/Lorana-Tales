import { expect, test } from "@playwright/test";

for(const width of [1280,690]) test(`CQ filter preserves reply text and restores content at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.addInitScript(()=>{localStorage.clear();document.cookie="lorana_tutorial_prompt_seen=1; Path=/; Max-Age=315360000";});
 await page.goto("/story");
 const input=page.locator(".composer [contenteditable=true]");
 for(const text of ["[CQ:reply,id=123]#烧烤这些传闻🤔","普通正文","[CQ:at,qq=12345]混合正文"]){
   await input.fill(text);await page.getByRole("button",{name:"发送",exact:true}).click();
 }
 await expect(page.locator(".story-message")).toHaveCount(3);
 await page.locator(".composer-more__trigger").click();
 await page.getByRole("button",{name:"过滤与删除"}).click();
 const card=page.locator(".composer-more__panel article").filter({has:page.getByText("所有 CQ 码",{exact:true})});
 await card.getByRole("switch").click();
 await expect(page.locator(".story-message")).toHaveCount(3);
 await expect(page.locator(".story-message").filter({hasText:"#烧烤这些传闻🤔"})).toBeVisible();
 await expect(page.locator(".story-message").filter({hasText:"混合正文"})).not.toContainText("@12345");
 await card.getByRole("switch").click();
 await expect(page.locator(".story-message").filter({hasText:"混合正文"})).toContainText("@12345");
 await card.getByRole("switch").click();
 await page.getByRole("button",{name:"关闭更多",exact:true}).click();
 await page.getByRole("button",{name:"演出编辑",exact:true}).click();
 await expect(page.locator("article.player-message").filter({hasText:"#烧烤这些传闻🤔"})).toBeVisible();
 await expect(page.locator("article.player-message").filter({hasText:"混合正文"})).not.toContainText("@12345");
});
