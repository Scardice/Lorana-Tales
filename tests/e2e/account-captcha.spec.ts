import { expect, test } from "@playwright/test";
import { createChallenge } from "altcha-lib/v1";

for (const mobile of [false, true]) test(`inline ALTCHA login and mail continuation (${mobile ? "mobile" : "desktop"})`, async ({page}) => {
 page.setDefaultTimeout(12000);
 if(mobile) await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>{document.cookie="lorana_tutorial_prompt_seen=1; Path=/; Max-Age=315360000";});
 let solves=0, logins=0, sends=0, authenticated=false;
 const user={id:"test",username:"test-user",nickname:"测试用户",email:"test@example.test",mustChangePassword:false};
 await page.route("**/api/account/**", async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.endsWith("/config")) return route.fulfill({json:{enabled:true,registrationEnabled:true,captchaProvider:"altcha"}});
   if(path.endsWith("/me")) return route.fulfill({json:{authenticated,user:authenticated?user:null}});
   if(path.endsWith("/captcha/challenge")) return route.fulfill({json:{id:"challenge",provider:"altcha",challenge:await createChallenge({hmacKey:"test",maxNumber:1000})}});
   if(path.endsWith("/captcha/verify")) {solves++; expect(route.request().postDataJSON().scope).toBe("auth-login");return route.fulfill({json:{clearance:"auth-proof",mailClearance:"mail-proof"}});}
   if(path.endsWith("/verification/send")) {sends++;expect(route.request().postDataJSON().captchaClearance).toBe("mail-continuation");return route.fulfill({json:{id:"mail-id",resendAfterSeconds:60}});}
   if(path.endsWith("/login")) {
     logins++;expect(route.request().headers()["x-captcha-clearance"]).toBe(logins===1?"auth-proof":"auth-continuation");
     if(logins===1)return route.fulfill({status:428,json:{error:"email_verification_required",email:user.email,clearance:"auth-continuation",mailClearance:"mail-continuation"}});
     expect(route.request().postDataJSON().code).toBe("123456");authenticated=true;return route.fulfill({json:{user}});
   }
   return route.fulfill({json:path.endsWith("effect-presets")?{items:[],folders:[],limit:100}:[]});
 });
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("/story");
 await page.locator(".account-trigger").click();
 const form=page.locator(".account-form").first();
 await expect(form.locator(".captcha-inline")).toBeVisible();
 await expect(form.locator(".submit")).toBeDisabled();
 await form.getByLabel("用户名或邮箱",{exact:true}).fill("test-user");
 await form.getByLabel("密码",{exact:true}).fill("not-a-real-password");
 await form.locator("altcha-widget").getByText("I'm not a robot",{exact:true}).click();
 await expect(form.getByText("人机验证已通过",{exact:true})).toBeVisible();
 await form.locator(".submit").click();
 await expect(form.getByText("新设备邮件验证码",{exact:false})).toBeVisible();
 await form.getByRole("button",{name:"发送验证码",exact:true}).click();
 await expect(form.getByRole("button",{name:/重新发送/})).toBeDisabled();
 await form.locator(".code-field__input").fill("123456");
 await form.locator(".submit").click();
 await expect(page.locator(".workspace-nav")).toBeAttached();
 await expect(page.locator(".captcha-overlay")).toHaveCount(0);
 expect(solves).toBe(1);expect(logins).toBe(2);expect(sends).toBe(1);expect(errors).toEqual([]);
});
