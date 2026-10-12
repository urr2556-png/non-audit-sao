# เปิดระบบ Non-Audit บน Render

ชุดนี้ใช้ Web Service แบบ Docker พร้อม persistent disk เก็บฐานข้อมูล SQLite กลาง ผู้ใช้ทุกเครื่องเปิด URL ของ Render เดียวกันเพื่อสมัคร login และจัดทำรายงาน

**ชุดไฟล์พร้อมติดตั้ง แต่ยังไม่ได้สร้างบริการหรือ deploy ในบัญชี Render ของคุณ**

## 1. นำไฟล์ขึ้น GitHub

1. แตก ZIP `non-audit-render.zip`
2. เปิด https://github.com/urr2556-png/non-audit-sao
3. เลือก **Add file → Upload files**
4. อัปโหลดไฟล์และโฟลเดอร์ **ที่อยู่ภายใน** `non-audit-render` ไปยังโฟลเดอร์หลักของ repository ไม่อัปโหลดตัว ZIP และไม่อัปโหลดโฟลเดอร์ครอบ
5. ตรวจว่ามี `render.yaml`, `Dockerfile`, `server.mjs`, `document-schema.mjs`, `package.json` อยู่ใน root และมีโฟลเดอร์ `public/`
6. กด **Commit changes**

ไฟล์ HTML เดิมที่อยู่ใน root สามารถคงไว้ได้ Render ใช้ไฟล์ภายใน `public/` ของชุดนี้ การเปลี่ยนไฟล์หน้าเว็บบน Render ให้แก้ไฟล์ `public/ชื่อหน้า.html`

รูปแบบที่ต้องเห็น:

```text
non-audit-sao/
├── render.yaml
├── Dockerfile
├── server.mjs
├── document-schema.mjs
├── package.json
└── public/
    ├── index.html
    ├── register.html
    ├── login.html
    ├── create-report.html
    ├── admin.html
    ├── search-reports.html
    ├── system.js
    └── assets/
```

## 2. สมัครหรือเข้าสู่ Render

1. เปิด https://dashboard.render.com/
2. สมัครหรือเข้าสู่ระบบด้วยบัญชีของคุณ
3. เชื่อม GitHub และอนุญาตให้ Render เข้าถึง repository `urr2556-png/non-audit-sao`

หากบัญชี GitHub ที่เข้า Render ไม่ใช่เจ้าของ repository ต้องมีสิทธิ์เข้าถึง repository ก่อน

## 3. สร้างบริการจาก Blueprint

1. เลือก **New → Blueprint**
2. เลือก repository `non-audit-sao`
3. เลือก branch `main`
4. ใช้ไฟล์ `render.yaml` ที่ root
5. ตรวจรายการบริการและราคาที่ Render แสดงก่อนกดสร้าง
6. สร้างหรือ deploy Blueprint แล้วรอให้บริการขึ้น **Live**

ไฟล์กำหนด:

| รายการ | ค่า |
|---|---|
| ประเภท | Web Service |
| Runtime | Docker |
| Region | Singapore |
| Compute plan | `0.5c-512mb` ตามรหัสปัจจุบันของ Render |
| จำนวน instance | 1 |
| Persistent disk | 1 GB ที่ `/data` |
| Health check | `/api/health` |
| Auto deploy | ปิด ต้องเลือก deploy เมื่อต้องการนำ commit ใหม่ขึ้นใช้งาน |

บริการนี้มีค่าใช้จ่าย รวมบริการ compute และ disk ไม่เลือก Free เพราะฐานข้อมูลชุดนี้ต้องเก็บใน persistent disk

หาก Render ใช้ชื่อแพลนที่ต่างจากไฟล์ ให้ตรวจแพลน paid ที่รองรับ disk ในหน้าปัจจุบัน ไม่สลับไปใช้ filesystem ชั่วคราว

## 4. เปิดเว็บไซต์

ในหน้าบริการ Render จะมี URL เช่น `https://non-audit-sao-xxxx.onrender.com`

ชื่อจริงอาจต่างจากตัวอย่าง ใช้ URL ที่ Render แสดงเท่านั้น ระบบอ่าน URL นี้จาก `RENDER_EXTERNAL_URL` อัตโนมัติ ไม่ต้องแก้ URL API ทีละหน้า

เมื่อเปิดหน้าแรกได้ แปลว่าหน้าเว็บทำงาน แต่ต้องสร้างบัญชี Admin ต่อก่อนใช้งานการอนุมัติ

## 5. สร้างบัญชี Admin ครั้งแรก

1. เปิดบริการ Render ที่ขึ้น Live
2. เปิดเมนู **Shell** ของบริการเดียวกัน ไม่ใช้ build command หรือ pre-deploy command เพราะ disk ใช้ได้ตอน runtime
3. วางคำสั่งต่อไปนี้:

```bash
read -r -p "Admin email: " ADMIN_EMAIL
read -r -p "Admin full name: " ADMIN_NAME
read -r -s -p "New password (12+ characters): " ADMIN_PASSWORD
export ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
node server.mjs create-admin
unset ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD
```

4. ใส่อีเมล ชื่อ และรหัสผ่านใหม่บนหน้า Shell รหัสผ่านไม่ปรากฏขณะพิมพ์
5. เมื่อเห็น `Admin created. Password is not printed.` ให้เปิดเว็บไซต์ของ Render แล้ว login

สร้าง Admin เพียงครั้งเดียวต่อบัญชี หากข้อความบอก Email already exists จะไม่มีการแก้บัญชีเดิม ห้ามส่งรหัสผ่านในแชตหรือเพิ่มลงไฟล์ GitHub

## 6. ผู้ตรวจสอบเริ่มใช้งาน

1. ผู้ตรวจสอบเปิดเว็บไซต์ Render → ลงทะเบียน
2. บัญชีผู้สมัครเป็น `pending`
3. Admin login → กด **อนุมัติผู้สมัคร** → **อนุมัติ**
4. ผู้ตรวจสอบ login → **สร้างรายงาน**
5. กรอกหน้าปกและส่วนอื่น → **บันทึกทั้งเล่ม**
6. เปิด **รายงานที่บันทึก** เพื่อกลับมาแก้ไขต่อ

ชุดนี้ยังไม่มีอีเมลยืนยันอัตโนมัติ Admin ต้องตรวจตัวตนก่อนอนุมัติ ระบบ AI ยังต้องเชื่อมบริการแยกต่างหาก

## 7. เปลี่ยนแปลงโค้ดในภายหลัง

1. แก้ไฟล์ใน GitHub แล้ว commit
2. ในบริการ Render เลือก **Manual Deploy → Deploy latest commit**
3. รอ Live และตรวจหน้าเว็บ

ฐานข้อมูลอยู่ใน disk `/data` จึงคงอยู่เมื่อ deploy ใหม่ อย่าลบบริการหรือ disk โดยไม่มีสำเนาข้อมูล

## 8. สำรองข้อมูล

เปิด Shell ของบริการแล้วรัน:

```bash
node server.mjs backup
```

ระบบสร้างไฟล์ backup ใน `/data` ต้องนำสำเนาออกไปเก็บต่างพื้นที่ด้วย วิธีนำออกและการกู้คืนอยู่ใน README และเอกสาร persistent disk ของ Render

## ปัญหาที่อาจพบ

| อาการ | ตรวจสอบ |
|---|---|
| ไม่พบ Dockerfile หรือ render.yaml | อัปโหลดไฟล์ลง root ถูกหรือไม่ มีโฟลเดอร์ครอบเกินมาหรือไม่ |
| สร้างบริการไม่ได้ | อ่านข้อความ Blueprint validation และตรวจการเข้าถึง repository |
| Deploy failed | เปิด Logs ของบริการ ส่งเฉพาะข้อความ error โดยไม่ส่งรหัสผ่าน |
| เขียนฐานข้อมูลไม่ได้ | disk mount `/data` และ `DATA_DIR=/data` ต้องตรงกัน |
| Login ขึ้น ORIGIN_DENIED | เปิดจาก URL ของ Render ไม่ใช่ GitHub Pages; ถ้าใช้โดเมนใหม่ ตั้ง APP_ORIGIN เป็น HTTPS origin นั้น |
| สมัครแล้ว login ไม่ได้ | ต้องให้ Admin อนุมัติก่อน |
| ข้อมูลหายหลัง deploy | ตรวจว่ามี persistent disk จริงและ DATA_DIR อยู่บน disk |
| AI ใช้ไม่ได้ | บริการ AI ยังไม่ได้ติดตั้ง ไม่ใช่ความผิดพลาดของ login |

แหล่งอ้างอิง:
- https://render.com/docs/blueprint-spec
- https://render.com/docs/environment-variables
- https://render.com/docs/disks
- https://render.com/pricing
