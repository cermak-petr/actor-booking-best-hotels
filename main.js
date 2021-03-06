const Apify = require('apify');
const request = require('request-promise');

/**
 * Gets attribute as text from a ElementHandle.
 * @param {ElementHandle} element - The element to get attribute from.
 * @param {string} attr - Name of the attribute to get.
 */
async function getAttribute(element, attr){
    try{
        const prop = await element.getProperty(attr);
        return (await prop.jsonValue()).trim();
    }
    catch(e){return null;}
}

/**
 * Adds links from a page to the RequestQueue.
 * @param {Page} page - Puppeteer Page object containing the link elements.
 * @param {RequestQueue} requestQueue - RequestQueue to add the requests to.
 * @param {string} selector - A selector representing the links.
 * @param {Function} condition - Function to check if the link is to be added.
 * @param {string} label - A label for the added requests.
 * @param {Function} urlMod - Function for modifying the URL.
 * @param {Function} keyMod - Function for generating uniqueKey from the link ElementHandle.
 */
async function enqueueLinks(page, requestQueue, selector, condition, label, urlMod, keyMod){
    const links = await page.$$(selector);
    for(const link of links){
        const href = await getAttribute(link, 'href');
        if(href && (!condition || await condition(link))){
            await requestQueue.addRequest(new Apify.Request({
            	userData: {label: label},
            	url: urlMod ? urlMod(href) : href,
            	uniqueKey: keyMod ? (await keyMod(link)) : href
            }));
        }
    }
}

/** Main function */
Apify.main(async () => {
    
    // Actor INPUT variable
    const input = await Apify.getValue('INPUT');
    
    // Actor STATE variable
    const state = await Apify.getValue('STATE') || {crawled: {}};
    
    // Migrating flag
    let migrating = false;
    Apify.events.on('migrating', data => {migrating = true;});
    
    // Check if all required input attributes are present.
    if(!input.search && !input.startUrls){
        throw new Error('Missing "search" or "startUrls" attribute in INPUT!');
    }
    if(!(input.proxyConfig && input.proxyConfig.useApifyProxy)){
        throw new Error('This actor cannot be used without Apify proxy.');
    }
    if(input.minScore){input.minScore = parseFloat(input.minScore);}
    const sortBy = input.sortBy || 'bayesian_review_score';
    
    // Main request queue.
    const requestQueue = await Apify.openRequestQueue();
    
    /**
     * Adds URL parameters to a Booking.com URL (timespan, language and currency).
     * @param {string} url - Booking.com URL to add the parameters to.
     */
    const addUrlParameters = url => {
        if(url.indexOf('?') < 0){url += '?';}
        if(input.checkIn && input.checkOut){
            const ci = input.checkIn.split(/-|\//);
            const co = input.checkOut.split(/-|\//);
            url += `&checkin_year_month_monthday=${ci[2]}-${ci[0]}-${ci[1]}`;
            url += `&checkout_year_month_monthday=${co[2]}-${co[0]}-${co[1]}`;
        }
        if(input.currency){
            url += `&selected_currency=${input.currency.toUpperCase()}&changed_currency=1&top_currency=1`;
        }
        if(input.language){
            const lng = input.language.replace('_','-');
            url += `&lang=${lng}`;
        }
        if(input.adults){url += '&group_adults=' + input.adults;}
        if(input.children){url += '&group_children=' + input.children;}
        if(input.rooms){url += '&no_rooms=' + input.rooms;}
        return url.replace('?&', '?');
    }
    
    let startUrl = undefined;
    let requestList = undefined;
    if(input.startUrls){
        // check if attribute is an Array
        if(!Array.isArray(input.startUrls)){
            throw new Error('INPUT.startUrls must an array!');
        }
        // convert any inconsistencies to correct format
        for(let i = 0; i < input.startUrls.length; i++){
            let request = input.startUrls[i];
            if(typeof request === 'string'){request = {url: request};}
            if((!request.userData || !request.userData.label !== 'detail') && request.url.indexOf('/hotel/') > -1){
                request.userData = {label: 'detail'};
            }
            request.url = addUrlParameters(request.url);
            input.startUrls[i] = request;
        }
        // create RequestList and reference startUrl
        requestList = new Apify.RequestList({sources: input.startUrls});
        startUrl = addUrlParameters('https://www.booking.com/searchresults.html?dest_type=city;ss=paris&order=bayesian_review_score');
        await requestList.initialize();
    }
    else{
        // Create startURL based on provided INPUT.
        const query = encodeURIComponent(input.search);
        startUrl = `https://www.booking.com/searchresults.html?dest_type=city;ss=${query}&order=${sortBy}`;
        startUrl = addUrlParameters(startUrl);

        // Enqueue all pagination pages.
        startUrl += '&rows=20';
        console.log('startUrl: ' + startUrl);
        await requestQueue.addRequest(new Apify.Request({url: startUrl, userData: {label: 'start'}}));
        if(!input.useFilters && input.maxPages){
            for(let i = 1; i <= input.maxPages; i++){
                await requestQueue.addRequest(new Apify.Request({
                    url: startUrl + '&offset=' + 20*i, 
                    userData: {label: 'page'}
                }));
            }
        }
    }
    
    // Temporary fix, make UI proxy input compatible
    if(input.proxyConfig && input.proxyConfig.apifyProxyGroups){
        for(let i = 0; i < input.proxyConfig.apifyProxyGroups.length; i++){
            const gSpl = input.proxyConfig.apifyProxyGroups[i].split('-');
            const nGroup = gSpl[gSpl.length - 1];
            input.proxyConfig.apifyProxyGroups[i] = nGroup;
        }
    }
    
    /** Creates new Puppeteer Browser instance. */
    const launchPuppeteer = async () => {
        return await Apify.launchPuppeteer(input.proxyConfig || {});
    };
    
    let retiring = false;
    
    /** Finds a browser instance with working proxy for Booking.com. */
    async function getWorkingBrowser(){
        if(!input.testProxy){return await launchPuppeteer();}
        for(let i = 0; i < 1000; i++){
            console.log('testing proxy...');
            const browser = await launchPuppeteer();
            const page = await browser.newPage();
            await page.goto(startUrl);
            const pageUrl = await page.url();
            if(pageUrl.indexOf(sortBy) > -1 || i === 999){
                console.log('valid proxy found');
                await page.close();
                retiring = false;
                return browser;
            }
            console.log('invalid proxy, retrying...');
            await browser.close();
            retiring = false;
        }
    }
    
    // Simulated browser chache
    const cache = {};
    
    // Main crawler variable.
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        
        requestQueue,
        
        launchPuppeteerFunction: getWorkingBrowser,
        
        // Main page handling function.
        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            
            /** 
             * Checks if page has some criteria filtering enabled.
             * @param {Page} page - The page to be checked.
             */
            const isFiltered = async page => await page.$('.filterelement.active');
            
            /** 
             * Extracts data from a hotel list page.
             * @param {Object} input - The actor INPUT variable.
             */
            const listPageFunction = (input) => new Promise((resolve, reject) => {
   
                const $ = jQuery;
   
                /** 
                 * Waits for a condition to be non-false.
                 * @param {Function} condition - The condition Function.
                 * @param {Function} callback - Callback to be executed when the waiting is done.
                 */
                function waitFor(condition, callback, i){
                    const val = condition();
                    if(val){callback(val);}
                    else if(i > 10){callback(null);}
                    else{setTimeout(function(){waitFor(condition, callback, i ? i+1 : 1);}, 500);}
                }
                
                /** Gets total number of listings. */
                const getHeaderNumber = function(){
                    const av = $('.availability_nr').text().trim().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const h1 = $('.sr_header h1').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const h2 = $('.sr_header h2').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const h4 = $('#results_prev_next h4').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const fd = $('#sr-filter-descr').text().replace(/(\s|\.|,)+/g, '').match(/(\d+)de/);
                    return av ? av[0] : (h1 ? h1[0] : (h2 ? h2[0] : (h4 ? h4[0] : (fd ? fd[1] : null))));
                }
                
                // Extract listing data.
                const result = [];
                const num = getHeaderNumber();
                const items = $('.sr_item');//$('.sr_item').eq(0).nextUntil('.sr_separator').addBack();
                console.log('items: ' + items.length);
                let started = 0;
                let finished = 0;
                
                // Iterate all items
                items.each(function(index, sr){
                    const jThis = $(this);
                    const n1 = jThis.find('.score_from_number_of_reviews').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const n2 = jThis.find('.review-score-widget__subtext').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const n3 = jThis.find('.bui-review-score__text').text().replace(/(\s|\.|,)+/g, '').match(/\d+/);
                    const nReviews = n1 || n2 || n3;
                    if(true){
                        ++started;
                        sr.scrollIntoView();
                        const getPrice = function(){
                            return $(sr).find(':not(strong).site_price, .totalPrice, strong.price');
                        }
                        
                        // When the price is ready, extract data.
                        waitFor(function(){return getPrice().length > 0;}, function(){
                            const occ = jThis.find('.sr_max_occupancy i').length;
                            const rl = jThis.find('.room_link').contents();
                            const prtxt = getPrice().eq(0).text().trim().replace(/\,|\s/g, '');
                            const pr = prtxt.match(/\d+/);
                            const pc = prtxt.match(/[^\d]+/);
                            const rat = $(sr).attr('data-score');
                            const found = num ? parseInt(num) : null;
                            const starAttr = jThis.find('i.star_track svg').attr('class');
                            const stars = starAttr ? starAttr.match(/\d/) : null;
                            const loc = jThis.find('.district_link').attr('data-coords');
                            const latlng = loc ? loc.split(',') : null;
                            const image = jThis.find('.sr_item_photo_link.sr_hotel_preview_track').attr('style');
                            const imageRegexp = /url\((.*?)\)/gm;
                            const imageParsed = imageRegexp.exec(image);
                            const url = window.location.origin + jThis.find('.hotel_name_link').attr('href').replace(/\n/g, '');
                            const item = {
                                'url': url.split('?')[0],
                                'name': $(sr).find('.sr-hotel__name').text().trim(),
                                'rating': rat ? parseFloat(rat.replace(',', '.')) : null,
                                'reviews': nReviews ? parseInt(nReviews[0]) : null,
                                'stars': stars ? parseInt(stars[0]) : null,
                                'price': pr ? parseFloat(pr[0]) : null,
                                'currency': pc ? pc[0].trim() : null,
                                'roomType': rl.length > 0 ? rl[0].textContent.trim() : null,
                                'persons': occ ? occ : null,
                                'location': latlng ? {lat: latlng[0], lng: latlng[1]} : null,
                                'image': image
                            };
                            if(!input.useFilters){item.totalFound = found;}
                            if(item.rating && item.rating >= (input.minScore || 0)){result.push(item);}
                            if(++finished >= started){resolve(result);}
                        });
                    }
                    else{resolve([]);}
                });
            });
            
            /** 
             * Creates a function to make sure the URL contains all necessary attributes from INPUT.
             * @param {string} s - The URL attribute separator (& or ;).
             */
            const fixUrl = s => href => {
                href = href.replace(/#([a-zA-Z_]+)/g, '');
                if(input.language && href.indexOf('lang') < 0){
                    const lng = input.language.replace('_','-');
                    if(href.indexOf(s)){
                        href.replace(s, `${s}lang=${lng}${s}`);
                    }
                    else{href += `${s}lang=${lng}`;}
                }
                if(input.currency && href.indexOf('currency') < 0){
                    href += `${s}selected_currency=${input.currency.toUpperCase()}${s}changed_currency=1${s}top_currency=1`;
                }
                return href.replace(/&{n,}/g, '&').replace('?&', '?');
            };
            
            console.log('open url(' + request.userData.label + '): ' + await page.url());
            
            /** Extracts information about all rooms listed by the hotel. */
            const extractRooms = async () => {
                let roomType, bedText, features;
                const rooms = [];
                
                // Iterate all table rows.
                const rows = await page.$$('.hprt-table > tbody > tr:not(.hprt-cheapest-block-row)');
                for(const row of rows){
                    const roomRow = await row.$('.hprt-table-cell-roomtype');
                    if(roomRow){
                        roomType = await row.$('.hprt-roomtype-icon-link');
                        const bedType = await row.$('.hprt-roomtype-bed');
                        bedText = bedType ? await getAttribute(bedType, 'textContent') : null;
                        
                        // Iterate and parse all room facilities.
                        const facilities = roomRow ? await roomRow.$$('.hprt-facilities-facility') : null;
                        features = [];
                        if(facilities){
                            for(const f of facilities){
                                const fText = (await getAttribute(f, 'textContent')).replace('•', '').trim();
                                if(fText.indexOf('ft²') > -1){
                                    const num = parseInt(fText.split(' ')[0]);
                                    const nText = parseInt(num*0.092903) + ' m²';
                                    features.push(nText);
                                }
                                else{features.push(fText);}
                            }
                        }
                    }
                    
                    // Extract data for each room.
                    let occupancy;
                    try{
                        occupancy = await row.$eval('.hprt-occupancy-occupancy-info', hprt => {
                            if(!hprt){return null;}
                            const occ1 = document.querySelector('.hprt-occupancy-occupancy-info .invisible_spoken');
                            const occ2 = document.querySelector('.hprt-occupancy-occupancy-info').getAttribute('data-title');
                            const occ3 = document.querySelector('.hprt-occupancy-occupancy-info').textContent;
                            return occ1 ? occ1.textContent : (occ2 || occ3);
                        });
                    }
                    catch(e){occupancy = null;}
                    const persons = occupancy ? occupancy.match(/\d+/) : null;
                    const priceE = await row.$('.hprt-price-price');
                    const prict = priceE ? await getAttribute(priceE, 'textContent') : null;
                    const priceT = priceE ? (await getAttribute(priceE, 'textContent')).replace(/\s|,/g, '').match(/(\d|\.)+/) : null;
                    const priceC = priceE ? (await getAttribute(priceE, 'textContent')).replace(/\s|,/g, '').match(/[^\d\.]+/) : null;
                    const cond = await row.$$('.hprt-conditions li');
                    
                    const room = {available: true};
                    if(roomType){room.roomType = await getAttribute(roomType, 'textContent');}
                    if(bedText){room.bedType = bedText.replace(/\n+/g, ' ');}
                    if(persons){room.persons = parseInt(persons[0]);}
                    if(priceT && priceC){
                        room.price = parseFloat(priceT[0]);
                        room.currency = priceC[0];
                        room.features = features;
                    }
                    else{room.available = false;}
                    if(cond.length > 0){
                        room.conditions = [];
                        for(const c of cond){
                            const cText = await getAttribute(c, 'textContent');
                            room.conditions.push(cText.replace(/(\n|\s)+/g, ' '));
                        }
                    }
                    await rooms.push(room);
                }
                return rooms;
            };
            
            /** Tells the crawler to re-enqueue current page and destroy the browser. 
             *  Necessary if the page was open through a not working proxy. */
            const retireBrowser = async () => {
                //if(retiring){return;}
                retiring = true;
                //console.log('proxy invalid, re-enqueuing...');
                await puppeteerPool.retire(page.browser());
                await requestQueue.addRequest(new Apify.Request({
                    url: request.url,
                    userData: request.userData,
                    uniqueKey: Math.random() + ''
                }));
            };
            
            // Check if startUrl was open correctly 
            if(input.startUrls){
                const pageUrl = await page.url();
                if(pageUrl.length < request.url.length){
                    await retireBrowser();
                    return;
                }
            }
            
            // Extract data from the hotel detail page
            if(request.userData.label === 'detail'){
                
                // wait for necessary elements
                try{
                    await page.waitForSelector('.hprt-occupancy-occupancy-info');
                    /*await page.waitForFunction(() => {
                        const script = document.querySelector('script[type="application/ld+json"]');
                        try{
                            const data = JSON.parse(script.textContent);
                            return (data && data.ggregateRating) ? true : false;
                        }
                        catch(e){return false;}
                    });*/
                }
                catch(e){}
                
                const html = await page.content();
                const ldElem = await page.$('script[type="application/ld+json"]');
                const ld = JSON.parse(await getAttribute(ldElem, 'textContent'));
                
                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if(!input.startUrls && pageUrl.indexOf('label') < 0){
                    await retireBrowser();
                    return;
                }
                
                // Exit if core data is not present ot the rating is too low.
                if(!ld || (ld.aggregateRating && ld.aggregateRating.ratingValue <= (input.minScore || 0))){
                    return;
                }
                
                // Extract the data.
                const addr = ld.address || null;
                const address = {
                    full: addr.streetAddress,
                    postalCode: addr.postalCode,
                    street: addr.addressLocality,
                    country: addr.addressCountry,
                    region: addr.addressRegion
                };
                const name = await page.$('#hp_hotel_name');
                const hType = await page.$('.hp__hotel-type-badge');
                const bFast = await page.$('.ph-item-copy-breakfast-option');
                const starIcon = await page.$('i.bk-icon-stars');
                const starTitle = await getAttribute(starIcon, 'title');
                const stars = starTitle ? starTitle.match(/\d/) : null;
                const loc = ld.hasMap ? ld.hasMap.match(/%7c(\d+\.\d+),(\d+\.\d+)/) : null;
                const cInOut = await page.$('.bui-date__subtitle');
                const cMatch = cInOut ? (await getAttribute(cInOut, 'textContent')).match(/\d+:(\d+)/g) : null;
                const img1 = await getAttribute(await page.$('.slick-track img'), 'src');
                const img2 = await getAttribute(await page.$('#photo_wrapper img'), 'src');
                const img3 = html.match(/large_url: '(.+)'/);
                const rooms = await extractRooms();
                await Apify.pushData({
                    url: addUrlParameters((await page.url()).split('?')[0]),
                    name: await getAttribute(name, 'textContent'),
                    type: await getAttribute(hType, 'textContent'),
                    description: ld.description || null,
                    stars: stars ? stars[0] : null,
                    rating: ld.aggregateRating ? ld.aggregateRating.ratingValue : null,
                    reviews: ld.aggregateRating ? ld.aggregateRating.reviewCount : null,
                    breakfast: await getAttribute(bFast, 'textContent'),
                    checkIn: (cMatch && cMatch.length > 1) ? cMatch[0] : null, 
                    checkOut: (cMatch && cMatch.length > 1) ? cMatch[1] : null,
                    location: (loc && loc.length > 2) ? {lat: loc[1], lng: loc[2]} : null,
                    address: address,
                    image: img1 || img2 || (img3 ? img3[1] : null),
                    rooms: rooms
                });
            }
            // Handle hotel list page.
            else{
                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if(!input.startUrls && pageUrl.indexOf(sortBy) < 0){
                    await retireBrowser();
                    return;
                }
                
                const filtered = await isFiltered(page);
                if((!input.useFilters && !input.maxPages) || filtered){
                    const baseUrl = await page.url();
                    if(baseUrl.indexOf('offset') < 0){
                        console.log('enqueuing pagination pages...');
                        const countElem = await page.$('.sorth1');
                        const countData = (await getAttribute(countElem, 'textContent')).replace(/\.|,|\s/g, '').match(/\d+/);
                        if(countData){
                            const count = Math.ceil(parseInt(countData[0])/20);
                            console.log('pagination pages: ' + count);
                            for(let i = 0; i <= count; i++){
                                await requestQueue.addRequest(new Apify.Request({
                                    url: baseUrl + '&rows=20&offset=' + 20*i, 
                                    userData: {label: 'page'}
                                }));
                            }
                        }
                    }
                }
                
                // If filtering is enabled, enqueue necessary pages.
                if(input.useFilters){
                    if(!filtered){
                        console.log('enqueuing filtered pages...');
                        await enqueueLinks(page, requestQueue, '.filterelement', null, 'page', fixUrl('&'), async link => {
                            const lText = await getAttribute(link, 'textContent');
                            return lText + '_' + 0;
                        });
                    }
                    else{
                        /*const filter = await getAttribute(filtered, 'textContent');
                        await enqueueLinks(page, requestQueue, '.sr_pagination_link', null, 'page', fixUrl('&'), async link => {
                            const lText = await getAttribute(link, 'textContent');
                            return filter + '_' + lText;
                        });*/
                    }
                }
                
                // If simple output is enough, extract the data.
                if(input.simple){
                    console.log('extracting data...');
                    await Apify.utils.puppeteer.injectJQuery(page);
                    const result = await page.evaluate(listPageFunction, input);
                    if(result.length > 0){
                        const toBeAdded = [];
                        for(const item of result){
                            item.url = addUrlParameters(item.url);
                            if(!state.crawled[item.name]){
                                toBeAdded.push(item);
                                state.crawled[item.name] = true;
                            }
                        }
                        if(migrating){await Apify.setValue('STATE', state);}
                        if(toBeAdded.length > 0){await Apify.pushData(toBeAdded);}
                    }
                }
                
                // If not, enqueue the detail pages to be extracted.
                else if(!input.useFilters || await isFiltered(page)){
                    console.log('enqueuing detail pages...');
                    await enqueueLinks(page, requestQueue, '.hotel_name_link', null, 'detail', fixUrl('&'), async link => {
                        return await getAttribute(link, 'textContent');
                    });
                }
            }
        },
        
        // Failed request handling
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                url: request.url,
                succeeded: false,
                errors: request.errorMessages,
            })
        },
        
        // Function for ignoring all unnecessary requests.
        gotoFunction: async ({ page, request }) => {
            await page.setRequestInterception(true);
            
            page.on('request', async (request) => {
                const url = request.url();
                if (url.includes('.js')) request.abort();
                else if (url.includes('.png')) request.abort();
                else if (url.includes('.jpg')) request.abort();
                else if (url.includes('.gif')) request.abort();
                else if (url.includes('.css')) request.abort();
                else if (url.includes('static/fonts')) request.abort();
                else if (url.includes('js_tracking')) request.abort();
                else if (url.includes('facebook.com')) request.abort();
                else if (url.includes('googleapis.com')) request.abort();
                else if (url.includes('secure.booking.com')) request.abort();
                else if (url.includes('booking.com/logo')) request.abort();
                else if (url.includes('booking.com/navigation_times')) request.abort();
                else{
                    // Return cached response if available
                    if(cache[url] && cache[url].expires > Date.now()){
                        await request.respond(cache[url]);
                        return;
                    }
                    request.continue();
                }
            });
            
            // Cache responses for future needs
            page.on('response', async (response) => {
                const url = response.url();
                const headers = response.headers();
                const cacheControl = headers['cache-control'] || '';
                const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
                const maxAge = maxAgeMatch && maxAgeMatch.length > 1 ? parseInt(maxAgeMatch[1], 10) : 0;
                if (maxAge && input.cacheResponses) {
                    if (!cache[url] || cache[url].expires > Date.now()) return;

                    cache[url] = {
                        status: response.status(),
                        headers: response.headers(),
                        body: buffer,
                        expires: Date.now() + (maxAge * 1000),
                    };
                }
            });
        	
        	// Hide WebDriver and return new page.
            await Apify.utils.puppeteer.hideWebDriver(page);
            return await page.goto(request.url, {timeout: 200000});
        }
    });
    
    // Start the crawler.
    await crawler.run();
});
